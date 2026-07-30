(function () {
  const PASSCODE = "4434";
  const STORAGE_KEY = "ihear_passcode_verified";

  function isVerified() {
    return localStorage.getItem(STORAGE_KEY) === "true";
  }

  function showPasscodeGate() {
    // Prevent scrolling of the background
    document.body.style.overflow = "hidden";

    const overlay = document.createElement("div");
    overlay.id = "passcode-gate";
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: #ffffff;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 9999999;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    `;

    const content = document.createElement("div");
    content.style.cssText = `
      max-width: 400px;
      width: 90%;
      text-align: center;
      padding: 40px 30px;
      border-radius: 24px;
      box-shadow: 0 20px 50px rgba(0,0,0,0.1);
      border: 1px solid #f0f0f0;
      background: #ffffff;
    `;

    content.innerHTML = `
      <div style="margin-bottom: 24px;">
        <div style="width: 64px; height: 64px; background: #f0f4ff; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px;">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#263974" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
        </div>
        <h2 style="margin: 0; color: #263974; font-size: 24px; font-weight: 700;">Protected Access</h2>
        <p style="color: #666; margin: 8px 0 0; font-size: 15px;">Please enter the passcode to continue.</p>
      </div>
      <div style="position: relative; margin-bottom: 16px;">
        <input type="password" id="passcode-input" placeholder="••••" maxlength="8" style="
          width: 100%;
          padding: 14px;
          font-size: 24px;
          letter-spacing: 8px;
          border: 2px solid #e0e0e0;
          border-radius: 12px;
          text-align: center;
          outline: none;
          transition: border-color 0.2s;
          color: #263974;
        ">
      </div>
      <button id="passcode-submit" style="
        width: 100%;
        padding: 14px;
        font-size: 16px;
        background: #263974;
        color: #fff;
        border: none;
        border-radius: 12px;
        cursor: pointer;
        font-weight: 600;
        transition: opacity 0.2s, transform 0.1s;
      ">Enter Site</button>
      <p id="passcode-error" style="color: #ef4444; margin-top: 16px; font-size: 14px; display: none; font-weight: 500;">
        Incorrect passcode. Please try again.
      </p>
    `;

    overlay.appendChild(content);
    document.body.appendChild(overlay);

    const input = document.getElementById("passcode-input");
    const submit = document.getElementById("passcode-submit");
    const error = document.getElementById("passcode-error");

    input.addEventListener("focus", () => {
      input.style.borderColor = "#263974";
    });

    input.addEventListener("blur", () => {
      input.style.borderColor = "#e0e0e0";
    });

    function check() {
      if (input.value === PASSCODE) {
        localStorage.setItem(STORAGE_KEY, "true");
        document.body.style.overflow = "";
        overlay.style.opacity = "0";
        overlay.style.transition = "opacity 0.3s ease";
        setTimeout(() => overlay.remove(), 300);
      } else {
        error.style.display = "block";
        input.value = "";
        input.style.borderColor = "#ef4444";
        input.focus();
        
        // Shake effect
        content.style.transform = "translateX(10px)";
        setTimeout(() => content.style.transform = "translateX(-10px)", 50);
        setTimeout(() => content.style.transform = "translateX(50px)", 100);
        setTimeout(() => content.style.transform = "translateX(-5px)", 150);
        setTimeout(() => content.style.transform = "translateX(0)", 200);
      }
    }

    submit.addEventListener("click", check);
    submit.addEventListener("mousedown", () => submit.style.transform = "scale(0.98)");
    submit.addEventListener("mouseup", () => submit.style.transform = "scale(1)");
    
    input.addEventListener("keypress", (e) => {
      if (e.key === "Enter") check();
      error.style.display = "none";
      input.style.borderColor = "#263974";
    });

    // Auto-focus after a short delay to ensure it works on all browsers
    setTimeout(() => input.focus(), 100);
  }

  // Check verification state
  if (!isVerified()) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", showPasscodeGate);
    } else {
      showPasscodeGate();
    }
  }
})();
