(() => {
  const host = document.getElementById('adFrameHost');
  if (!host) return;

  const isMobile = window.matchMedia('(max-width: 767px)').matches;

  const frame = document.createElement('iframe');
  frame.className = isMobile ? 'ad-frame ad-frame-sp' : 'ad-frame ad-frame-pc';
  frame.title = '広告';
  frame.setAttribute('scrolling', 'no');
  frame.setAttribute('frameborder', '0');
  frame.setAttribute('aria-label', '広告');
  frame.referrerPolicy = 'strict-origin-when-cross-origin';
  frame.src = isMobile ? './ad-sp.html' : './ad-pc.html';

  host.replaceChildren(frame);
})();
