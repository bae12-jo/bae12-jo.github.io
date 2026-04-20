(function() {
  function getLang() {
    return localStorage.getItem('preferred-lang') || 'ko';
  }

  function setLang(lang) {
    localStorage.setItem('preferred-lang', lang);
  }

  function applyLang(lang) {
    document.querySelectorAll('.lang-ko').forEach(function(el) {
      el.style.display = lang === 'ko' ? '' : 'none';
    });
    document.querySelectorAll('.lang-en').forEach(function(el) {
      el.style.display = lang === 'en' ? '' : 'none';
    });
    document.querySelectorAll('.lang-toggle-btn').forEach(function(btn) {
      btn.textContent = lang === 'ko' ? 'EN' : '한';
    });
  }

  function toggleLang() {
    var current = getLang();
    var next = current === 'ko' ? 'en' : 'ko';
    var scrollY = window.scrollY;
    setLang(next);
    applyLang(next);
    window.scrollTo(0, scrollY);
  }

  function injectButton() {
    if (!document.querySelector('.lang-ko, .lang-en')) return;

    var header = document.querySelector('.book-header');
    if (!header) return;

    var btn = document.createElement('a');
    btn.className = 'lang-toggle-btn';
    btn.href = '#';
    btn.style.cssText = [
      'position:absolute',
      'right:16px',
      'top:0',
      'line-height:50px',
      'padding:0 12px',
      'font-size:13px',
      'font-weight:bold',
      'color:inherit',
      'text-decoration:none',
      'z-index:10'
    ].join(';');

    btn.addEventListener('click', function(e) {
      e.preventDefault();
      toggleLang();
    });

    header.style.position = 'relative';
    header.appendChild(btn);
  }

  document.addEventListener('DOMContentLoaded', function() {
    injectButton();
    applyLang(getLang());
  });
})();
