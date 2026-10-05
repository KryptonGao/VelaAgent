/** Local-only authentication integration: native popup relationships and WebAuthn. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, session, webContents } from "electron";
import { registerUiBrowserSecurity } from "../src/main/browser-security.ts";
import { registerBrowserWebAuthn } from "../src/main/browser-webauthn.ts";

const temporary = process.env.VELA_AUTH_SMOKE_TEMP ?? mkdtempSync(join(tmpdir(), "vela-browser-auth-"));
app.setPath("userData", join(temporary, "profile"));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await pause(25); }
  throw new Error(`Timed out: ${message}`);
}
let base;
let sandboxScripts = 0;
const server = createServer((request, response) => {
  if (request.url === "/sandbox-script-ran") { sandboxScripts++; response.end("recorded"); return; }
  if (request.url === "/redirect-blocked") { response.writeHead(302, { Location: "file:///tmp/private" }); response.end(); return; }
  response.setHeader("Content-Type", "text/html");
  if (request.url === "/sandbox-popup") {
    response.end('<title>Sandbox child</title><script>fetch("/sandbox-script-ran")</script>'); return;
  }
  if (request.url === "/sandbox") {
    response.end(`<iframe sandbox="allow-same-origin allow-popups" style="width:600px;height:300px" srcdoc='<a href="${base}/sandbox-popup" target="_blank">Restricted popup</a>'></iframe>`); return;
  }
  if (request.url === "/callback") {
    response.setHeader("Set-Cookie", "auth=complete; SameSite=Lax; Path=/");
    response.end(`<script>opener.postMessage({type:'authenticated'},${JSON.stringify(base)});close()</script>`); return;
  }
  response.end(`<!doctype html><title>Fixture</title><h1>Login fixture</h1><a id="modified" href="/modified">Modified link</a><script>
    window.received=[];addEventListener('message',e=>received.push({origin:e.origin,data:e.data}));
  </script>`);
});
const posts = [];
const provider = createServer((request, response) => {
  if (request.url === "/authorize") { response.writeHead(302, { Location: base + "/callback" }); response.end(); return; }
  if (request.method === "POST") {
    let body="";request.on('data',chunk=>body+=chunk);request.on('end',()=>{
      posts.push(body);response.setHeader("Content-Type","text/html");response.end('<h1>POST received</h1>');
    }); return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end('<title>Provider</title><h1>Provider login</h1>');
});
const watchdog = setTimeout(() => { console.error("Browser authentication smoke timed out"); app.exit(1); }, 60000);
async function run() {
  try {
    await Promise.all([new Promise(resolve => server.listen(0, "127.0.0.1", resolve)),
      new Promise(resolve => provider.listen(0, "127.0.0.1", resolve))]);
    base = `http://127.0.0.1:${server.address().port}`;
    const providerBase = `http://127.0.0.1:${provider.address().port}`;
    await app.whenReady();
    const browserSession = session.fromPartition("persist:vela-ui-browser");
    browserSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    const win = new BrowserWindow({ show: false, webPreferences: { webviewTag: true, sandbox: true, contextIsolation: true } });
    const accountPrompts = [];
    let holdAccount = false;
    const disposeWebAuthn = registerBrowserWebAuthn(browserSession, {
      selectionTimeoutMs: 300,
      contentsFromFrame: frame => webContents.fromFrame(frame),
      parentForContents: contents => BrowserWindow.fromWebContents(contents.hostWebContents ?? contents),
      showMessageBox: async (parent, options) => {
        assert.equal(parent, win); accountPrompts.push(options);
        if (holdAccount) return new Promise(resolve => options.signal.addEventListener("abort",
          () => resolve({ response: 0, checkboxChecked: false }), { once: true }));
        return { response: 1, checkboxChecked: false };
      },
    });
    const popups = [];
    registerUiBrowserSecurity(win.webContents, undefined, options => {
      const popup = new BrowserWindow({ ...options, show: false, parent: win }); popups.push(popup); return popup;
    });
    const renderer = join(temporary, "fixture.html");
    writeFileSync(renderer, '<webview partition="persist:vela-ui-browser" src="about:blank" allowpopups style="width:800px;height:600px"></webview>');
    await win.loadFile(renderer);
    await until(() => webContents.getAllWebContents().some(w => w.getType() === "webview"), "guest attachment");
    const guest = webContents.getAllWebContents().find(w => w.getType() === "webview");
    await guest.loadURL(base);
    const open = async (url, name = "auth") => {
      const count = popups.length;
      let timer;
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("window.open evaluation did not complete")), 5000); });
      try { await Promise.race([guest.executeJavaScript(`window.authPopup=window.open(${JSON.stringify(url)},${JSON.stringify(name)},'width=500,height=700');true`, true), deadline]); }
      finally { clearTimeout(timer); }
      await until(() => popups.length > count, "popup creation");
      const popup = popups.at(-1);
      await until(() => !popup.webContents.isLoading(), "popup loaded");
      return popup;
    };
    const popup = await open(providerBase);
    await until(() => popup.webContents.getURL() === providerBase + "/", "provider origin");
    const preferences = popup.webContents.getLastWebPreferences();
    assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.preload, undefined);
    assert.equal(popup.webContents.session, browserSession);
    assert.deepEqual(await popup.webContents.executeJavaScript('({opener:!!opener,node:typeof require,api:typeof window.vela})'),
      { opener: true, node: "undefined", api: "undefined" });
    await guest.executeJavaScript(`authPopup.postMessage('ping',${JSON.stringify(providerBase)})`);
    await popup.webContents.executeJavaScript(`location.href=${JSON.stringify(providerBase + "/authorize")}`);
    await until(() => popup.isDestroyed(), "provider callback closes popup");
    await until(() => guest.executeJavaScript("received.some(e=>e.data.type==='authenticated')"), "opener postMessage callback");
    assert.equal(await guest.executeJavaScript("location.href"), base + "/");
    assert.match(await guest.executeJavaScript("document.cookie"), /auth=complete/);
    assert.equal(await guest.executeJavaScript("authPopup.closed"), true);
    console.log("PASS cross-origin OAuth redirect, opener/postMessage/close, session reuse and child isolation");

    const blank = await open("about:blank", "blank");
    await guest.executeJavaScript(`authPopup.location.href=${JSON.stringify(providerBase)}`);
    await until(() => blank.webContents.getURL() === providerBase + "/" && !blank.webContents.isLoading(), "blank popup later navigation");
    assert.equal(blank.webContents.getLastWebPreferences().preload, undefined);
    assert.equal(await blank.webContents.executeJavaScript("!!opener"), true);
    await blank.webContents.executeJavaScript("close()");
    await until(() => blank.isDestroyed(), "blank popup closes");
    console.log("PASS about:blank popup then provider navigation with retained opener");

    await guest.executeJavaScript(`(()=>{const f=document.createElement('form');f.method='POST';f.target='_blank';f.action=${JSON.stringify(providerBase + "/post")};const i=document.createElement('input');i.name='state';i.value='oauth-proof';f.append(i);document.body.append(f);f.submit()})()`, true);
    await until(() => posts.length === 1, "popup POST body");
    assert.equal(posts[0], "state=oauth-proof");
    const postWindow = popups.at(-1); postWindow.destroy();
    console.log("PASS target=_blank form POST retains authentication request body");

    const guarded = await open(base + "/guard", "guarded");
    await guarded.webContents.executeJavaScript("location.href='file:///tmp/private'"); await pause(200);
    assert.ok(guarded.webContents.getURL().startsWith(base));
    await guarded.webContents.executeJavaScript(`location.href=${JSON.stringify(base + "/redirect-blocked")}`); await pause(300);
    assert.equal(guarded.webContents.getURL().startsWith("file:"), false);
    assert.equal(await guest.executeJavaScript("window.open('file:///tmp/private')===null", true), true);
    guarded.destroy();
    console.log("PASS privileged popup destinations, navigation and redirects are blocked");

    const modifiedClick = async (modifiers, inFrame = false) => {
      const point = await guest.executeJavaScript(`(()=>{
        const iframe=document.querySelector('iframe');
        const link=${inFrame ? "iframe.contentDocument.querySelector('a')" : "document.querySelector('#modified')"};
        const r=link.getBoundingClientRect();const f=${inFrame ? "iframe.getBoundingClientRect()" : "{left:0,top:0}"};
        return {x:Math.round(f.left+r.left+r.width/2+${inFrame ? 2 : 0}),y:Math.round(f.top+r.top+r.height/2+${inFrame ? 2 : 0})};
      })()`);
      const count = popups.length;
      guest.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1, modifiers });
      guest.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1, modifiers });
      await until(() => popups.length > count, "modified-link popup");
      const child = popups.at(-1);
      await until(() => !child.webContents.isLoading() && !!child.webContents.getURL(), "deferred popup navigation");
      return child;
    };
    const platformModifier = process.platform === "darwin" ? "meta" : "control";
    for (const modifiers of [[platformModifier], ["shift"], [platformModifier, "shift"]]) {
      const child = await modifiedClick(modifiers);
      assert.equal(child.webContents.getURL(), base + "/modified"); child.destroy();
    }
    await guest.loadURL(base + "/sandbox");
    await until(() => guest.executeJavaScript("!!document.querySelector('iframe').contentDocument?.querySelector('a')"), "sandbox iframe");
    for (const modifiers of [[], [platformModifier], ["shift"], [platformModifier, "shift"]]) {
      const child = await modifiedClick(modifiers, true);
      assert.equal(child.webContents.getURL(), base + "/sandbox-popup");
      await pause(200); assert.equal(sandboxScripts, 0, "HTML sandbox must block child scripts"); child.destroy();
    }
    await guest.loadURL(base);
    console.log("PASS modified-link popup navigation and inherited iframe HTML sandbox restrictions");

    // Exercises the real navigator.credentials pipeline without using a person's credentials.
    const credentialBase = base.replace("127.0.0.1", "localhost");
    await guest.loadURL(credentialBase);
    guest.debugger.attach("1.3");
    try {
      await guest.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
      await guest.debugger.sendCommand("WebAuthn.enable");
      const { authenticatorId } = await guest.debugger.sendCommand("WebAuthn.addVirtualAuthenticator", { options: {
        protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true,
        isUserVerified: true, automaticPresenceSimulation: true,
      } });
      const created = await guest.executeJavaScript(`(async()=>{
        const credential=await navigator.credentials.create({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),
          rp:{name:'Vela local fixture',id:'localhost'},user:{id:new Uint8Array([1]),name:'fixture',displayName:'Fixture'},
          pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{residentKey:'required',userVerification:'required'},timeout:5000}});
        return {id:credential.id,type:credential.type,client:JSON.parse(new TextDecoder().decode(credential.response.clientDataJSON))};
      })().catch(error=>({error:error.name+': '+error.message,focused:document.hasFocus(),visibility:document.visibilityState}))`, true);
      assert.equal(created.type, "public-key", JSON.stringify(created)); assert.equal(created.client.type, "webauthn.create"); assert.equal(created.client.origin, credentialBase);
      const assertion = await guest.executeJavaScript(`(async()=>{
        const credential=await navigator.credentials.get({publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),
          rpId:'localhost',userVerification:'required',timeout:5000}});
        return {id:credential.id,signature:credential.response.signature.byteLength,client:JSON.parse(new TextDecoder().decode(credential.response.clientDataJSON))};
      })().catch(error=>({error:error.name+': '+error.message}))`, true);
      assert.equal(assertion.id, created.id, JSON.stringify(assertion)); assert.ok(assertion.signature > 0);
      assert.equal(assertion.client.type, "webauthn.get"); assert.equal(assertion.client.origin, credentialBase);
      assert.equal(accountPrompts.length, 1); assert.match(accountPrompts[0].message, /localhost/);
      const navigationListeners = guest.listenerCount("did-start-navigation");
      holdAccount = true;
      await guest.executeJavaScript(`window.cancelController=new AbortController();window.cancelResult='pending';
        navigator.credentials.get({signal:cancelController.signal,publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),
          rpId:'localhost',timeout:5000}}).then(()=>cancelResult='ok',error=>cancelResult=error.name);true`, true);
      await until(() => accountPrompts.length === 2, "pending chooser");
      await guest.executeJavaScript("cancelController.abort();true");
      await until(() => guest.executeJavaScript("cancelResult==='AbortError'"), "page aborts credential request");
      await until(() => accountPrompts[1].signal.aborted, "stale chooser deadline");
      assert.equal(guest.listenerCount("did-start-navigation"), navigationListeners);
      holdAccount = false;
      await guest.debugger.sendCommand("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    } finally { guest.debugger.detach(); }
    console.log("PASS native WebAuthn registration, authentication, account selection and bounded page-abort cleanup (virtual authenticator)");
    await guest.loadURL(base);

    const retained = await open(providerBase, "retained");
    const popupCount = popups.length;
    await retained.webContents.executeJavaScript(`window.child=window.open(${JSON.stringify(base)},'nested');true`, true);
    await until(() => popups.length > popupCount, "nested popup");
    const nested = popups.at(-1);
    await win.webContents.executeJavaScript("document.querySelector('webview').remove()");
    await until(() => guest.isDestroyed() && retained.isDestroyed() && nested.isDestroyed(), "tab closure destroys popup tree");
    win.destroy();
    disposeWebAuthn();
    console.log("PASS guest closure disposes nested authentication windows");
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
  finally { clearTimeout(watchdog); server.close(); provider.close(); rmSync(temporary, { recursive: true, force: true }); }
}
void run();
