/**
 * VELAHARNESS — NATIVE MACOS CODEX-INSPIRED PROTOTYPE ENGINE
 * Matching User Screenshot: Frosted Blue Glass, Large Radii, Soft Diffused Shadows, No Borders
 */

// Simulated Mock Sessions aligned with Screenshot
const SESSIONS = {
  "chat-provider-key": {
    id: "chat-provider-key",
    project: "Glance",
    branch: "main",
    title: "修复 Provider 设置页密钥逻辑",
    tokenUsage: {
      used: 48290,
      total: 128000,
      system: 4120,
      conversation: 16840,
      files: 21430,
      tools: 5900
    },
    todos: [
      { id: 1, text: "在 Provider 设置页添加“测试连接”按钮逻辑", status: "completed" },
      { id: 2, text: "支持发送不带图片的 1 token 轻量级探测请求", status: "completed" },
      { id: 3, text: "增加“清除 API 密钥”显式清空输入框与 Keychain", status: "completed" },
      { id: 4, text: "检查中英文字符串本地化目录及 Simulator 构建", status: "in-progress" },
      { id: 5, text: "验证向真实兼容服务端发送连通性探测", status: "pending" }
    ],
    contextFiles: [
      { id: "f-1", name: "Glance/ProviderSettingsView.swift", type: "swift", tokens: 8400, pinned: true },
      { id: "f-2", name: "Shared/GlanceStorage.swift", type: "swift", tokens: 4600, pinned: true },
      { id: "f-3", name: "Shared/OpenAICompatibleProvider.swift", type: "swift", tokens: 5900, pinned: false },
      { id: "f-4", name: "Glance/Resources/Localizable.xcstrings", type: "md", tokens: 2530, pinned: false }
    ]
  },

  "chat-share-retry": {
    id: "chat-share-retry",
    project: "Glance",
    branch: "main",
    title: "修复分享扩展分析重试",
    tokenUsage: {
      used: 31200,
      total: 128000,
      system: 3800,
      conversation: 10400,
      files: 14200,
      tools: 2800
    },
    todos: [
      { id: 1, text: "捕获分享扩展宿主 App 超时异常信号", status: "completed" },
      { id: 2, text: "添加指数退避重试调度队列机制", status: "completed" },
      { id: 3, text: "向用户反馈重试失败降级弹窗", status: "pending" }
    ],
    contextFiles: [
      { id: "f-5", name: "ShareExtension/ShareViewController.swift", type: "swift", tokens: 6800, pinned: true },
      { id: "f-6", name: "Shared/NetworkRetryQueue.swift", type: "swift", tokens: 7400, pinned: true }
    ]
  },

  "chat-photo-picker": {
    id: "chat-photo-picker",
    project: "Glance",
    branch: "feat/photo-picker",
    title: "Add Photo Picker entry",
    tokenUsage: {
      used: 26800,
      total: 128000,
      system: 3200,
      conversation: 8900,
      files: 11800,
      tools: 2900
    },
    todos: [
      { id: 1, text: "Integrate PHPickerViewController in SwiftUI View", status: "completed" },
      { id: 2, text: "Handle HEIC to JPEG compression before payload transmit", status: "pending" }
    ],
    contextFiles: [
      { id: "f-7", name: "Glance/Views/PhotoPickerSheet.swift", type: "swift", tokens: 5600, pinned: true }
    ]
  }
};

let currentChatId = "chat-provider-key";
let isLeftCollapsed = false;
let isRightCollapsed = false;
let isDiffExpanded = false;

// DOM Elements
const elSidebarLeft = document.getElementById("sidebar-left");
const elSidebarRight = document.getElementById("sidebar-right");
const elChatHeaderTitle = document.getElementById("chat-header-title");
const elBranchLabel = document.getElementById("current-branch-label");
const elTodoCardsCol = document.getElementById("todo-cards-column");
const elPlanProgressText = document.getElementById("plan-progress-text");
const elPlanProgressFill = document.getElementById("plan-progress-fill");
const elContextFilesCol = document.getElementById("context-files-column");
const elTokenTotalDisplay = document.getElementById("token-total-display");
const elBarSystem = document.getElementById("bar-system");
const elBarConversation = document.getElementById("bar-conversation");
const elBarFiles = document.getElementById("bar-files");
const elBarTools = document.getElementById("bar-tools");
const elLegendSystem = document.getElementById("legend-system");
const elLegendConversation = document.getElementById("legend-conversation");
const elLegendFiles = document.getElementById("legend-files");
const elLegendTools = document.getElementById("legend-tools");
const elToast = document.getElementById("mac-toast");
const elToastText = document.getElementById("mac-toast-text");
const elPromptInput = document.getElementById("user-prompt-input");

// Toast helper
function showToast(msg) {
  if (!elToast) return;
  elToastText.textContent = msg;
  elToast.classList.add("show");
  setTimeout(() => {
    elToast.classList.remove("show");
  }, 2200);
}

// Format numbers
function fmtNum(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Toggle Sidebars
function toggleLeftSidebar() {
  isLeftCollapsed = !isLeftCollapsed;
  elSidebarLeft.classList.toggle("collapsed", isLeftCollapsed);
}

function toggleRightSidebar() {
  isRightCollapsed = !isRightCollapsed;
  elSidebarRight.classList.toggle("collapsed", isRightCollapsed);
  const btn = document.getElementById("btn-toggle-inspector");
  if (btn) btn.classList.toggle("active", !isRightCollapsed);
}

// Switch Chat Session
function switchChatSession(chatId) {
  if (!SESSIONS[chatId]) return;
  currentChatId = chatId;

  document.querySelectorAll(".subchat-item").forEach(el => {
    el.classList.toggle("active", el.dataset.chat === chatId);
  });

  const session = SESSIONS[chatId];
  if (elChatHeaderTitle) elChatHeaderTitle.textContent = session.title;
  if (elBranchLabel) elBranchLabel.textContent = session.branch;

  renderPlanAndContext();
  scrollToBottom(false);
  showToast(`已切换至: ${session.title}`);
}

// Render Plan (Todos) and Context
function renderPlanAndContext() {
  const session = SESSIONS[currentChatId];
  if (!session) return;

  // 1. Render Todos
  if (elTodoCardsCol) {
    elTodoCardsCol.innerHTML = "";
    const doneCount = session.todos.filter(t => t.status === "completed").length;
    const totalCount = session.todos.length;
    const pct = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;

    if (elPlanProgressText) elPlanProgressText.textContent = `${doneCount}/${totalCount} 完成 (${pct}%)`;
    if (elPlanProgressFill) elPlanProgressFill.style.width = `${pct}%`;

    session.todos.forEach(todo => {
      const card = document.createElement("div");
      card.className = `todo-card-item ${todo.status}`;
      card.onclick = () => toggleTodoItem(todo.id);

      let checkInner = "";
      if (todo.status === "completed") {
        checkInner = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
      } else if (todo.status === "in-progress") {
        checkInner = `<span style="width: 5px; height: 5px; border-radius: 50%; background: var(--accent-blue);"></span>`;
      }

      card.innerHTML = `
        <div class="todo-round-check">${checkInner}</div>
        <div class="todo-text-main">${escapeHtml(todo.text)}</div>
      `;
      elTodoCardsCol.appendChild(card);
    });
  }

  // 2. Render Context & Token Metrics
  const { used, total, system, conversation, files, tools } = session.tokenUsage;
  if (elTokenTotalDisplay) {
    elTokenTotalDisplay.innerHTML = `${fmtNum(used)} <span>/ ${fmtNum(total)} (${Math.round((used/total)*100)}%)</span>`;
  }

  if (elBarSystem) elBarSystem.style.width = `${(system / total) * 100}%`;
  if (elBarConversation) elBarConversation.style.width = `${(conversation / total) * 100}%`;
  if (elBarFiles) elBarFiles.style.width = `${(files / total) * 100}%`;
  if (elBarTools) elBarTools.style.width = `${(tools / total) * 100}%`;

  if (elLegendSystem) elLegendSystem.textContent = fmtNum(system);
  if (elLegendConversation) elLegendConversation.textContent = fmtNum(conversation);
  if (elLegendFiles) elLegendFiles.textContent = fmtNum(files);
  if (elLegendTools) elLegendTools.textContent = fmtNum(tools);

  // 3. Render Context Files
  if (elContextFilesCol) {
    elContextFilesCol.innerHTML = "";
    session.contextFiles.forEach(file => {
      const item = document.createElement("div");
      item.className = "context-file-pill-card";
      item.innerHTML = `
        <div class="file-info-col" onclick="openFilePreview('${file.name.split('/').pop()}')" style="cursor:pointer;">
          <span class="file-pill-icon ${file.type}">${file.type.toUpperCase()}</span>
          <span class="file-name-truncated" title="${file.name}">${file.name.split('/').pop()}</span>
        </div>
        <div class="file-pill-actions">
          <button class="file-icon-btn" title="${file.pinned ? '已锁定' : '锁定文件'}" onclick="togglePinFile('${file.id}')">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="${file.pinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2">
              <line x1="12" y1="17" x2="12" y2="22"></line>
              <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.8l-1.78.89A2 2 0 0 0 5 15.24Z"></path>
            </svg>
          </button>
          <button class="file-icon-btn delete" title="从上下文移出" onclick="removeContextFile('${file.id}')">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      `;
      elContextFilesCol.appendChild(item);
    });
  }
}

// Toggle Todo item state
function toggleTodoItem(todoId) {
  const session = SESSIONS[currentChatId];
  if (!session) return;
  const item = session.todos.find(t => t.id === todoId);
  if (item) {
    if (item.status === "completed") {
      item.status = "pending";
    } else if (item.status === "pending") {
      item.status = "in-progress";
    } else {
      item.status = "completed";
    }
    renderPlanAndContext();
    showToast(`任务已更新: ${item.text.slice(0, 18)}...`);
  }
}

// Add New Todo Task
function addNewTodoTask() {
  const text = prompt("输入待办任务内容:", "验证测试连接超时降级处理");
  if (!text) return;
  const session = SESSIONS[currentChatId];
  session.todos.push({
    id: Date.now(),
    text: text,
    status: "pending"
  });
  renderPlanAndContext();
  showToast("已添加新待办任务");
}

// Toggle Time Spent Collapsible Stream
let isTimeSpentExpanded = true;
function toggleTimeSpentStream() {
  const container = document.getElementById("time-spent-collapsible");
  if (!container) return;
  isTimeSpentExpanded = !isTimeSpentExpanded;
  container.classList.toggle("expanded", isTimeSpentExpanded);
}

// Toggle Substream Tool Execution List
let isSubstreamCollapsed = false;
function toggleSubstream() {
  const sub = document.getElementById("substream-collapsible");
  if (!sub) return;
  isSubstreamCollapsed = !isSubstreamCollapsed;
  sub.classList.toggle("collapsed", isSubstreamCollapsed);
}

// Scroll To Bottom (Smooth or Instant) and Hide Float Button
function scrollToBottom(smooth = true) {
  const container = document.getElementById("chat-messages-container");
  const btn = document.getElementById("btn-scroll-bottom");
  if (btn) {
    btn.classList.remove("visible");
  }
  if (container) {
    if (smooth) {
      container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    } else {
      container.scrollTop = container.scrollHeight;
    }
  }
}

// Scroll to bottom observer: strictly hide button when at bottom; only show when scrolled up > 120px
function setupScrollButtonObserver() {
  const container = document.getElementById("chat-messages-container");
  const btn = document.getElementById("btn-scroll-bottom");
  if (!container || !btn) return;

  function update() {
    const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
    // Show only when user has scrolled away from the bottom by > 120px
    if (dist > 120) {
      btn.classList.add("visible");
    } else {
      btn.classList.remove("visible");
    }
  }

  container.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update, { passive: true });
  update();
}

// Toggle Tool Card Details (Diff)
function toggleDiffDetails() {
  const block = document.getElementById("diff-detail-block");
  const card = document.getElementById("tool-summary-card");
  const txt = document.getElementById("expand-files-text");
  isDiffExpanded = !isDiffExpanded;

  if (block && card) {
    card.classList.toggle("expanded", isDiffExpanded);
    if (txt) {
      txt.textContent = isDiffExpanded ? "收起文件变更" : "再显示 1 个文件";
    }
  }
}

function toggleToolCard() {
  toggleDiffDetails();
}

// Toggle Folder in Sidebar
function toggleFolder(folderKey) {
  showToast(`展开目录: ${folderKey}`);
}

// Context File Actions
function removeContextFile(fileId) {
  const session = SESSIONS[currentChatId];
  const file = session.contextFiles.find(f => f.id === fileId);
  if (!file) return;

  session.tokenUsage.files -= file.tokens;
  session.tokenUsage.used -= file.tokens;
  session.contextFiles = session.contextFiles.filter(f => f.id !== fileId);

  renderPlanAndContext();
  showToast(`已从上下文移出: ${file.name.split('/').pop()}`);
}

function togglePinFile(fileId) {
  const session = SESSIONS[currentChatId];
  const file = session.contextFiles.find(f => f.id === fileId);
  if (file) {
    file.pinned = !file.pinned;
    renderPlanAndContext();
    showToast(file.pinned ? `已锁定 ${file.name.split('/').pop()}` : `已取消锁定`);
  }
}

function pruneContext() {
  const session = SESSIONS[currentChatId];
  const unpinned = session.contextFiles.filter(f => !f.pinned);
  if (unpinned.length === 0) {
    showToast("没有未锁定的上下文文件需要修剪");
    return;
  }
  let saved = 0;
  unpinned.forEach(f => saved += f.tokens);
  session.tokenUsage.files -= saved;
  session.tokenUsage.used -= saved;
  session.contextFiles = session.contextFiles.filter(f => f.pinned);

  renderPlanAndContext();
  showToast(`已清理 ${unpinned.length} 个未锁定文件 (释放 ${fmtNum(saved)} Tokens)`);
}

// Mock File Contents for In-sidebar Code Inspector (Matching Screenshot 3)
const MOCK_FILE_CONTENTS = {
  "ProviderSettingsView.swift": {
    path: "Glance > Glance > ProviderSettingsView.swift",
    code: `<span class="syn-kw">import</span> <span class="syn-type">SwiftUI</span>

<span class="syn-kw">struct</span> <span class="syn-type">ProviderSettingsView</span>: <span class="syn-type">View</span> 
{
    <span class="syn-mod">@State</span> <span class="syn-kw">private var</span> name = <span class="syn-str">""</span>
    <span class="syn-mod">@State</span> <span class="syn-kw">private var</span> baseURL = <span class="syn-str">""</span>

    <span class="syn-mod">@State</span> <span class="syn-kw">private var</span> modelID = <span class="syn-str">""</span>

    <span class="syn-mod">@State</span> <span class="syn-kw">private var</span> apiKey = <span class="syn-str">""</span>

    <span class="syn-mod">@State</span> <span class="syn-kw">private var</span> hasStoredKey = <span class="syn-kw">false</span>
    <span class="syn-mod">@State</span> <span class="syn-kw">private var</span> searchEngine: <span class="syn-type">SearchEngine</span> = .google

    <span class="syn-mod">@State</span> <span class="syn-kw">private var</span> statusMessage: <span class="syn-type">String?</span>
    <span class="syn-mod">@State</span> <span class="syn-kw">private var</span> isTestingConnection = <span class="syn-kw">false</span>

    <span class="syn-kw">var</span> body: <span class="syn-kw">some</span> <span class="syn-type">View</span> {
        <span class="syn-func">Form</span> {
            <span class="syn-func">Section</span> {
                <span class="syn-func">TextField</span>(<span class="syn-str">"Name"</span>, text: $name, prompt: <span class="syn-func">Text</span>(<span class="syn-str">"OpenAI"</span>))
                <span class="syn-func">TextField</span>(<span class="syn-str">"Base URL"</span>, text: $baseURL, prompt: <span class="syn-func">Text</span>(<span class="syn-str">"https://api.openai.com/v1"</span>))
                <span class="syn-func">SecureField</span>(<span class="syn-str">"API Key"</span>, text: $apiKey)
            }
            <span class="syn-func">Section</span> {
                <span class="syn-func">Button</span>(<span class="syn-str">"测试连接"</span>) {
                    testConnection()
                }
                <span class="syn-func">Button</span>(<span class="syn-str">"清除 API 密钥"</span>, role: .destructive) {
                    clearKey()
                }
            }
        }
    }
}`
  },

  "GlanceStorage.swift": {
    path: "Glance > Shared > GlanceStorage.swift",
    code: `<span class="syn-kw">import</span> <span class="syn-type">Foundation</span>
<span class="syn-kw">import</span> <span class="syn-type">Security</span>

<span class="syn-kw">final class</span> <span class="syn-type">GlanceStorage</span> {
    <span class="syn-kw">static let</span> shared = <span class="syn-type">GlanceStorage</span>()
    <span class="syn-kw">private let</span> serviceName = <span class="syn-str">"com.chenkaigao.glance.auth"</span>

    <span class="syn-kw">func</span> clearAPIKey(for account: <span class="syn-type">String</span>) -> <span class="syn-type">Bool</span> {
        <span class="syn-kw">let</span> query: [<span class="syn-type">String</span>: <span class="syn-type">Any</span>] = [
            kSecClass <span class="syn-kw">as</span> <span class="syn-type">String</span>: kSecClassGenericPassword,
            kSecAttrService <span class="syn-kw">as</span> <span class="syn-type">String</span>: serviceName,
            kSecAttrAccount <span class="syn-kw">as</span> <span class="syn-type">String</span>: account
        ]
        <span class="syn-kw">let</span> status = <span class="syn-func">SecItemDelete</span>(query <span class="syn-kw">as</span> <span class="syn-type">CFDictionary</span>)
        <span class="syn-kw">return</span> status == errSecSuccess || status == errSecItemNotFound
    }
}`
  },

  "OpenAICompatibleProvider.swift": {
    path: "Glance > Shared > OpenAICompatibleProvider.swift",
    code: `<span class="syn-kw">import</span> <span class="syn-type">Foundation</span>

<span class="syn-kw">public struct</span> <span class="syn-type">OpenAICompatibleProvider</span> {
    <span class="syn-kw">public let</span> endpoint: <span class="syn-type">URL</span>
    <span class="syn-kw">public let</span> apiKey: <span class="syn-type">String</span>

    <span class="syn-kw">public func</span> testConnection() <span class="syn-kw">async throws</span> -> <span class="syn-type">Bool</span> {
        <span class="syn-kw">var</span> request = <span class="syn-type">URLRequest</span>(url: endpoint.appendingPathComponent(<span class="syn-str">"chat/completions"</span>))
        request.httpMethod = <span class="syn-str">"POST"</span>
        request.setValue(<span class="syn-str">"Bearer \\(apiKey)"</span>, forHTTPHeaderField: <span class="syn-str">"Authorization"</span>)
        request.setValue(<span class="syn-str">"application/json"</span>, forHTTPHeaderField: <span class="syn-str">"Content-Type"</span>)
        <span class="syn-kw">let</span> payload = [<span class="syn-str">"model"</span>: <span class="syn-str">"gpt-4o"</span>, <span class="syn-str">"max_tokens"</span>: 1]
        request.httpBody = <span class="syn-kw">try</span> <span class="syn-type">JSONSerialization</span>.data(withJSONObject: payload)
        <span class="syn-kw">let</span> (_, response) = <span class="syn-kw">try await</span> <span class="syn-type">URLSession</span>.shared.data(for: request)
        <span class="syn-kw">return</span> (response <span class="syn-kw">as?</span> <span class="syn-type">HTTPURLResponse</span>)?.statusCode == 200
    }
}`
  },

  "Localizable.xcstrings": {
    path: "Glance > Glance > Resources > Localizable.xcstrings",
    code: `{
  <span class="syn-str">"sourceLanguage"</span> : <span class="syn-str">"zh-Hans"</span>,
  <span class="syn-str">"strings"</span> : {
    <span class="syn-str">"Test Connection"</span> : {
      <span class="syn-str">"localizations"</span> : {
        <span class="syn-str">"zh-Hans"</span> : { <span class="syn-str">"stringUnit"</span> : { <span class="syn-str">"value"</span> : <span class="syn-str">"测试连接"</span> } },
        <span class="syn-str">"en"</span> : { <span class="syn-str">"stringUnit"</span> : { <span class="syn-str">"value"</span> : <span class="syn-str">"Test Connection"</span> } }
      }
    },
    <span class="syn-str">"Clear API Key"</span> : {
      <span class="syn-str">"localizations"</span> : {
        <span class="syn-str">"zh-Hans"</span> : { <span class="syn-str">"stringUnit"</span> : { <span class="syn-str">"value"</span> : <span class="syn-str">"清除 API 密钥"</span> } }
      }
    }
  }
}`
  }
};

// Open In-Sidebar File Preview (Hiding Todo & Context)
function openFilePreview(rawFileName) {
  const fileName = rawFileName.split('/').pop().trim();
  const fileData = MOCK_FILE_CONTENTS[fileName] || {
    path: `Glance > ${fileName}`,
    code: `<span class="syn-comment">// Preview for ${fileName}</span>\n<span class="syn-kw">import</span> <span class="syn-type">Foundation</span>\n\n<span class="syn-comment">// Content loaded dynamically</span>`
  };

  // 1. Ensure Right Sidebar is visible and expanded
  if (isRightCollapsed) {
    toggleRightSidebar();
  }

  // 2. Switch sidebar into preview mode (Hiding Todo & Context)
  elSidebarRight.classList.add("preview-mode");

  // 3. Update active tab text
  const elTabFileName = document.getElementById("preview-tab-filename");
  if (elTabFileName) elTabFileName.textContent = fileName;

  // 4. Update breadcrumbs leaf
  const elBreadcrumbLeaf = document.getElementById("preview-breadcrumb-leaf");
  if (elBreadcrumbLeaf) elBreadcrumbLeaf.textContent = fileName;

  // 5. Update code content
  const elCodeContent = document.getElementById("code-lines-content");
  if (elCodeContent) {
    elCodeContent.innerHTML = fileData.code;
  }

  // 6. Highlight file in tree
  document.querySelectorAll(".explorer-tree-item").forEach(item => {
    const text = item.textContent.trim();
    if (text.endsWith(fileName)) {
      item.classList.add("active");
    } else if (!item.classList.contains("dir")) {
      item.classList.remove("active");
    }
  });

  showToast(`已在右侧预览: ${fileName}`);
}

// Close File Preview (Restoring Todo & Context)
function closeFilePreview() {
  elSidebarRight.classList.remove("preview-mode");
  showToast("已切换回 Todo & Context 面板");
}

function previewFile(name) {
  openFilePreview(name);
}

function focusSearch() {
  showToast("搜索会话与代码文件 (Cmd+K)");
}

function createNewChat() {
  showToast("已创建新对话");
}

// Handle User Sending Message
function handleUserSend() {
  if (!elPromptInput) return;
  const text = elPromptInput.value.trim();
  if (!text) return;

  const container = document.getElementById("chat-messages-container");
  if (!container) return;

  // Append user bubble
  const userRow = document.createElement("div");
  userRow.className = "user-msg-container";
  userRow.innerHTML = `<div class="user-bubble">${escapeHtml(text)}</div>`;
  container.appendChild(userRow);

  // Clear input
  elPromptInput.value = "";
  scrollToBottom(true);

  // Simulate Agent thinking
  showToast("Vela 正在思考并执行...");
  setTimeout(() => {
    const agentProse = document.createElement("div");
    agentProse.className = "agent-reply-prose";
    agentProse.innerHTML = `已收到指令：“<strong>${escapeHtml(text)}</strong>”。正在分析对应文件并执行相应更改。`;
    container.appendChild(agentProse);
    scrollToBottom(true);
  }, 600);
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Global Keyboard Shortcuts
window.addEventListener("keydown", (e) => {
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const mod = isMac ? e.metaKey : e.ctrlKey;

  // Toggle Left Sidebar (Cmd+B)
  if (mod && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    toggleLeftSidebar();
  }

  // Toggle Right Sidebar (Cmd+J)
  if (mod && e.key.toLowerCase() === 'j') {
    e.preventDefault();
    toggleRightSidebar();
  }

  // Focus Search (Cmd+K)
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    focusSearch();
  }

  // Enter to send in textarea
  if (e.target === elPromptInput && e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleUserSend();
  }
});

// Init on load
document.addEventListener("DOMContentLoaded", () => {
  renderPlanAndContext();

  if (elPromptInput) {
    elPromptInput.addEventListener("input", function() {
      this.style.height = "auto";
      this.style.height = Math.min(this.scrollHeight, 140) + "px";
    });
  }

  // Scroll to bottom on initial load and initialize observer
  scrollToBottom(false);
  setupScrollButtonObserver();
});
