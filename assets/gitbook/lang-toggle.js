// Language toggle with scroll preservation
(function() {
  function getLang() {
    return localStorage.getItem('preferred-lang') || 'ko';
  }

  function setLang(lang) {
    localStorage.setItem('preferred-lang', lang);
  }

  function applyLang(lang) {
    document.querySelectorAll('.lang-ko').forEach(el => {
      el.style.display = lang === 'ko' ? '' : 'none';
    });
    document.querySelectorAll('.lang-en').forEach(el => {
      el.style.display = lang === 'en' ? '' : 'none';
    });
    document.querySelectorAll('.lang-toggle-btn').forEach(btn => {
      btn.textContent = lang === 'ko' ? 'EN' : '한';
      btn.setAttribute('data-lang', lang);
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
    // Only inject on pages that have lang-ko/lang-en blocks
    if (!document.querySelector('.lang-ko, .lang-en')) return;

    var toolbar = document.querySelector('.book-header .pull-right');
    if (!toolbar) return;

    var btn = document.createElement('a');
    btn.className = 'lang-toggle-btn';
    btn.href = '#';
    btn.style.cssText = 'padding: 0 8px; font-size: 13px; font-weight: bold; line-height: 50px; display: inline-block; color: inherit; text-decoration: none;';
    btn.addEventListener('click', function(e) {
      e.preventDefault();
      toggleLang();
    });

    toolbar.insertBefore(btn, toolbar.firstChild);
  }

  document.addEventListener('DOMContentLoaded', function() {
    injectButton();
    applyLang(getLang());
  });
})();
