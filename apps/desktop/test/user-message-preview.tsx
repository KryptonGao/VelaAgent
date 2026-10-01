import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { UserMessageFrame } from "../src/renderer/components/UserMessageFrame";
import "../src/renderer/styles.css";
function Fixture() {
  const [text, setText] = useState("帮我把这个页面的布局调整一下。\n保留原来的配色和图片。");
  const [later, setLater] = useState(true);
  const [fail, setFail] = useState(false);
  return <main style={{ maxWidth: 720, margin: "60px auto", padding: 24 }}>
    <UserMessageFrame text={text} timestamp={new Date().setHours(18, 49, 0, 0)} disabled={false}
      onEdit={async next => {
        if (fail) throw new Error("文件在这轮之后又被修改，请先处理冲突再重新发送：src/app.tsx");
        setText(next); setLater(false);
      }}><div className="user-bubble" style={{ whiteSpace: "pre-wrap" }}>{text}</div></UserMessageFrame>
    {later ? <p style={{ marginTop: 28 }}>这段后续回复会在重新发送后移除。</p> : <p role="status" style={{ marginTop: 28 }}>已按修改后的消息重新开始。</p>}
    <label style={{ display: "block", marginTop: 30 }}><input type="checkbox" checked={fail} onChange={event => setFail(event.target.checked)} /> 模拟文件冲突</label>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
