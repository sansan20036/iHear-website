(() => {
  'use strict';

  const form = document.querySelector('[data-inquiry-form]');
  if (!form) return;

  const locale = form.dataset.locale === 'zh-Hant' ? 'zh-Hant' : 'en';
  const messages = {
    en: {
      submit: 'Send inquiry',
      sending: 'Sending…',
      required: 'Please complete this field.',
      email: 'Please enter a valid email address.',
      phone: 'Please enter a valid phone number, including the country code when needed.',
      invalidField: 'Please check this answer.',
      tooLong: 'Please shorten this answer.',
      invalid: 'Please check the highlighted fields and try again.',
      invalidServer: 'Please check your email address and answers, then try again.',
      success: 'Thank you! Your inquiry has been sent. The iHear team will follow up using the contact details you provided.',
      unavailable: 'Online inquiries are temporarily unavailable. Your answers are still here. Please email ihearprogram@gmail.com instead.',
      preview: 'This preview cannot send inquiries. Please use the published website or email ihearprogram@gmail.com.',
      rateLimited: 'Too many attempts. Please wait a few minutes before trying again, or email ihearprogram@gmail.com.',
      failed: 'Your inquiry was not sent. Your answers are still here. Please try again, or email ihearprogram@gmail.com.',
      inProgress: 'Your inquiry is still being processed. Please wait about a minute before pressing Send again.',
      unconfirmed: 'We could not confirm whether your inquiry was sent. Your answers are still here. You can try again in a few minutes, but the team may then receive it twice. You can also email ihearprogram@gmail.com instead.',
    },
    'zh-Hant': {
      submit: '送出詢問',
      sending: '正在送出…',
      required: '請填寫此欄位。',
      email: '請輸入有效的電子信箱。',
      phone: '請輸入有效的電話號碼，必要時加上國碼。',
      invalidField: '請確認此欄位的內容。',
      tooLong: '請縮短此欄位的內容。',
      invalid: '請確認標示的欄位後再送出。',
      invalidServer: '請確認電子信箱與填寫內容是否正確，再重新送出。',
      success: '謝謝您！詢問已送出，iHear 團隊會依您留下的聯絡方式與您聯繫。',
      unavailable: '線上詢問暫時無法使用，您填寫的內容已保留。請改寄信至 ihearprogram@gmail.com。',
      preview: '此預覽頁面無法送出詢問，請使用正式網站，或寄信至 ihearprogram@gmail.com。',
      rateLimited: '送出次數較多，請稍候幾分鐘再試，或寄信至 ihearprogram@gmail.com。',
      failed: '這次詢問沒有送出，您填寫的內容已保留。請再試一次，或寄信至 ihearprogram@gmail.com。',
      inProgress: '詢問仍在處理中，請稍候約一分鐘再按送出。',
      unconfirmed: '目前無法確認詢問是否已送出，您填寫的內容已保留。您可以幾分鐘後再試一次，但團隊可能會收到重複的詢問；也可以改寄信至 ihearprogram@gmail.com。',
    },
  }[locale];
  const errorMessages = {
    INVALID_INPUT: messages.invalidServer,
    ORIGIN_NOT_ALLOWED: messages.unavailable,
    RATE_LIMITED: messages.rateLimited,
    EMAIL_UNAVAILABLE: messages.unavailable,
    DELIVERY_FAILED: messages.failed,
    DELIVERY_IN_PROGRESS: messages.inProgress,
    DELIVERY_UNCONFIRMED: messages.unconfirmed,
  };
  // The email may already have been sent only after these outcomes. Resending
  // unchanged answers then reuses the reference, so Resend can recognize a
  // repeat within 24 hours and staff can match the reference after that.
  const maybeSent = new Set(['DELIVERY_IN_PROGRESS', 'DELIVERY_UNCONFIRMED']);

  const fields = ['firstName', 'lastName', 'email', 'phone', 'location', 'gradeLevel', 'subject', 'sessionFormat', 'startTime', 'contactMethod', 'availability', 'message', 'website'];
  const fieldset = form.querySelector('fieldset');
  const submit = form.querySelector('[type="submit"]');
  const status = form.querySelector('[data-inquiry-status]');
  let inFlight = false;
  let lastFingerprint = '';
  let requestId = '';

  function updatePhoneRequirement() {
    const required = form.elements.namedItem('contactMethod').value === 'phone';
    form.elements.namedItem('phone').required = required;
    form.querySelector('[data-phone-required]').hidden = !required;
    form.querySelector('[data-phone-hint]').hidden = !required;
  }

  function showStatus(message, state, focus = false) {
    status.textContent = message;
    status.dataset.state = state;
    if (focus) status.focus();
  }

  // File previews have no same-origin mail endpoint. Never forward their data elsewhere.
  if (!['http:', 'https:'].includes(window.location.protocol)) {
    showStatus(messages.preview, 'error');
    return;
  }
  if (!window.crypto || typeof window.crypto.randomUUID !== 'function') {
    showStatus(messages.unavailable, 'error');
    return;
  }

  form.noValidate = true;
  fieldset.disabled = false;
  updatePhoneRequirement();

  form.addEventListener('input', (event) => {
    if (typeof event.target.setCustomValidity === 'function') {
      event.target.setCustomValidity('');
      event.target.removeAttribute('aria-invalid');
    }
  });

  form.addEventListener('change', (event) => {
    if (event.target.name === 'contactMethod') {
      updatePhoneRequirement();
      const phone = form.elements.namedItem('phone');
      phone.setCustomValidity('');
      phone.removeAttribute('aria-invalid');
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (inFlight) return;
    updatePhoneRequirement();

    const payload = { locale };
    let firstInvalid = null;
    for (const name of fields) {
      const field = form.elements.namedItem(name);
      const value = field.value.trim();
      field.setCustomValidity('');
      let error = '';
      if (field.validity.valueMissing || (field.required && !value)) error = messages.required;
      else if (field.maxLength > -1 && value.length > field.maxLength) error = messages.tooLong;
      else if (name === 'email' && (field.validity.typeMismatch || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) error = messages.email;
      else if (name === 'phone' && value && (!/^[+\d\s().-]+$/.test(value) || value.replace(/\D/g, '').length < 5 || value.replace(/\D/g, '').length > 25)) error = messages.phone;
      else if (!field.validity.valid) error = messages.invalidField;
      field.setCustomValidity(error);
      if (error) {
        field.setAttribute('aria-invalid', 'true');
        if (!firstInvalid) firstInvalid = field;
      } else {
        field.removeAttribute('aria-invalid');
      }
      payload[name] = value;
    }
    if (firstInvalid) {
      showStatus(messages.invalid, 'error');
      firstInvalid.reportValidity();
      firstInvalid.focus();
      return;
    }

    // Changed answers are a new inquiry with a new reference.
    const fingerprint = JSON.stringify(payload);
    if (fingerprint !== lastFingerprint || !requestId) {
      lastFingerprint = fingerprint;
      requestId = window.crypto.randomUUID();
    }
    payload.requestId = requestId;

    inFlight = true;
    fieldset.disabled = true;
    form.setAttribute('aria-busy', 'true');
    submit.textContent = messages.sending;
    showStatus(messages.sending, 'pending');

    let code = 'DELIVERY_UNCONFIRMED';
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch('/api/academy-inquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      // Static previews may answer with an HTML 404/405/501 instead of the mail handler.
      if ([404, 405, 501].includes(response.status)) {
        code = 'EMAIL_UNAVAILABLE';
      } else {
        const result = await response.json();
        if (response.ok && result.ok === true) code = 'OK';
        else if (typeof result.code === 'string' && Object.prototype.hasOwnProperty.call(errorMessages, result.code)) code = result.code;
      }
    } catch {
      // Network and timeout failures cannot establish whether the server sent the email.
      code = 'DELIVERY_UNCONFIRMED';
    } finally {
      window.clearTimeout(timeout);
      inFlight = false;
      fieldset.disabled = false;
      form.removeAttribute('aria-busy');
      submit.textContent = messages.submit;
    }

    if (code === 'OK') {
      form.reset();
      updatePhoneRequirement();
      lastFingerprint = '';
      requestId = '';
      showStatus(messages.success, 'success', true);
      return;
    }
    // Nothing was sent, so the next attempt can safely use a new reference.
    if (!maybeSent.has(code)) requestId = '';
    showStatus(errorMessages[code], 'error', true);
  });
})();
