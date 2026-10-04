// Admin 页面交互逻辑
// 使用 data-action 和 data-id 属性，不用内联 onclick

function postJSON(path, data) {
  return fetch(path, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(data)
  }).then(function(r) {
    return r.text().then(function(text) {
      var body = {};
      try { body = text ? JSON.parse(text) : {}; }
      catch (e) { body = { error: text.slice(0, 200) || ('HTTP ' + r.status) }; }
      if (!r.ok || body.ok === false) {
        throw new Error(body.message || body.error || ('HTTP ' + r.status));
      }
      return body;
    });
  });
}

function reportFail(e) {
  var msg = (e && e.message) || String(e);
  console.error(msg);
  alert('失败: ' + msg);
}

function showSecret(container, secret) {
  // 清除旧的
  var old = container.parentElement.querySelector('.secret-box');
  if (old) old.remove();
  
  var div = document.createElement('div');
  div.className = 'secret-box';
  div.style.cssText = 'background:#e8f5e9;border:2px solid #4caf50;border-radius:6px;padding:10px;margin:8px 0';
  
  var label = document.createElement('b');
  label.textContent = '新 Secret（只显示一次）:';
  div.appendChild(label);
  div.appendChild(document.createElement('br'));
  
  var code = document.createElement('code');
  code.textContent = secret;
  code.style.wordBreak = 'break-all';
  code.style.fontSize = '14px';
  div.appendChild(code);
  div.appendChild(document.createElement('br'));
  
  var btn = document.createElement('button');
  btn.textContent = '复制';
  btn.style.marginLeft = '8px';
  btn.onclick = function() {
    navigator.clipboard.writeText(secret);
    btn.textContent = '已复制';
  };
  div.appendChild(btn);
  
  // 插到 agent 行的后面（下一行）
  container.parentElement.insertBefore(div, container.nextSibling);
}

function showCode(secret) {
  var box = document.getElementById('invite-result');
  box.style.display = 'block';
  box.innerHTML = '';
  var b = document.createElement('b');
  b.textContent = '邀请码（1小时有效）: ';
  box.appendChild(b);
  var code = document.createElement('code');
  code.textContent = secret;
  box.appendChild(code);
}

document.addEventListener('DOMContentLoaded', function() {
  // 换 Secret 按钮
  document.querySelectorAll('[data-action="rotate"]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var id = btn.getAttribute('data-id');
      var container = btn.closest('.agent-row');
      postJSON('rotate', {id: id}).then(function(r) {
        showSecret(container, r.secret);
      }).catch(reportFail);
    });
  });
  
  // 吊销按钮
  document.querySelectorAll('[data-action="revoke"]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var id = btn.getAttribute('data-id');
      postJSON('revoke', {id: id}).then(function() {
        location.reload();
      }).catch(reportFail);
    });
  });
  
  // 生成邀请码
  var inviteBtn = document.querySelector('[data-action="invite"]');
  if (inviteBtn) {
    inviteBtn.addEventListener('click', function() {
      postJSON('invite', {}).then(function(r) {
        showCode(r.code);
      }).catch(reportFail);
    });
  }
  
  // 通过按钮
  document.querySelectorAll('[data-action="approve"]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var id = btn.getAttribute('data-id');
      var email = prompt('输入邮箱 (xxx@abot.run):');
      if (!email) return;
      var container = btn.closest('.req-row');
      postJSON('approve', {id: id, email: email}).then(function(r) {
        showSecret(container, r.secret);
      }).catch(reportFail);
    });
  });
  
  // 拒绝按钮
  document.querySelectorAll('[data-action="deny"]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var id = btn.getAttribute('data-id');
      postJSON('deny', {id: id}).then(function() {
        location.reload();
      }).catch(reportFail);
    });
  });
});
