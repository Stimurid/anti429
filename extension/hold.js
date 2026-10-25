// Holding page for a chat tab that the owner restarted while looking at it (an active tab cannot be discarded).
// The address of the chat travels in the hash: #u=<url>&t=<title>. The worker navigates back when the server is calm.
const q = new URLSearchParams(location.hash.slice(1));
const url = q.get("u") || "";
const title = q.get("t") || url;
document.getElementById("chat").textContent = title;
document.title = "⏸ " + title;
const now = document.getElementById("now");
if (/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url)) now.href = url; else now.hidden = true;
