(() => {
  let apiPromise;
  function loadAPI() {
    if (window.YT?.Player) return Promise.resolve(window.YT);
    if (apiPromise) return apiPromise;
    apiPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const previous = window.onYouTubeIframeAPIReady;
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        window.onYouTubeIframeAPIReady = previous;
        if (error) { script.remove(); reject(error); }
        else { resolve(window.YT); if (typeof previous === 'function') previous(); }
      };
      const timer = setTimeout(() => finish(new Error('YouTube API timeout')), 15000);
      window.onYouTubeIframeAPIReady = () => finish();
      script.onerror = () => finish(new Error('YouTube API unavailable'));
      script.src = 'https://www.youtube.com/iframe_api';
      document.head.append(script);
    }).catch(error => { apiPromise = null; throw error; });
    return apiPromise;
  }
  const copy = locale => ({
    en: { loading: 'Loading video…', ready: 'If playback has not started, press play in the video.', slow: 'Video is taking longer to load. Try the player or open it on YouTube below.', error: 'This video could not play here. Open it on YouTube below.' },
    zhHant: { loading: '影片載入中…', ready: '若影片尚未開始，請點擊播放器中的播放鍵。', slow: '影片載入較久，可點擊播放器或使用下方連結在 YouTube 開啟。', error: '影片暫時無法在此播放，請使用下方連結在 YouTube 開啟。' },
    zhHans: { loading: '视频加载中…', ready: '若视频尚未开始，请点击播放器中的播放键。', slow: '视频加载较久，可点击播放器或使用下方链接在 YouTube 打开。', error: '视频暂时无法在此播放，请使用下方链接在 YouTube 打开。' },
  })[locale];
  window.iHearGalleryVideo = {
    start(frame, item, locale, title) {
      const text = copy(locale);
      let active = true, player;
      const iframe = document.createElement('iframe');
      iframe.src = `https://www.youtube-nocookie.com/embed/${item.videoId}?autoplay=1&playsinline=1&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`;
      iframe.title = title; iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      iframe.allowFullscreen = true; iframe.referrerPolicy = 'strict-origin-when-cross-origin';
      const overlay = document.createElement('div'); overlay.className = 'gallery-video-loading';
      const poster = new Image(); poster.src = `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`; poster.alt = '';
      poster.onerror = () => { poster.hidden = true; };
      const status = document.createElement('span'); status.setAttribute('role', 'status'); status.textContent = text.loading;
      overlay.append(poster, status); frame.replaceChildren(iframe, overlay); frame.setAttribute('aria-busy', 'true');
      const reveal = message => {
        if (!active) return;
        frame.removeAttribute('aria-busy'); overlay.classList.add('is-ready'); poster.hidden = true;
        overlay.hidden = !message; status.textContent = message || '';
      };
      let timer;
      const waitForPlayback = () => { clearTimeout(timer); timer = setTimeout(() => reveal(text.slow), 12000); };
      waitForPlayback();
      loadAPI().then(YT => {
        if (!active) return;
        player = new YT.Player(iframe, { events: {
          onReady: () => reveal(text.ready),
          onStateChange: event => {
            if (!active) return;
            if ([0, 1, 2].includes(event.data)) { clearTimeout(timer); reveal(''); }
            else if (event.data === 3) { reveal(text.loading); waitForPlayback(); }
          },
          onAutoplayBlocked: () => { clearTimeout(timer); reveal(text.ready); },
          onError: () => { clearTimeout(timer); reveal(text.error); },
        } });
      }).catch(() => { clearTimeout(timer); reveal(text.slow); });
      return () => { active = false; clearTimeout(timer); player?.destroy(); overlay.remove(); frame.removeAttribute('aria-busy'); };
    },
  };
})();
