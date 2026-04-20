(function() {
  function getLang() {
    var meta = document.querySelector('meta[name="page-lang"]');
    if (meta) return meta.getAttribute('content');
    return localStorage.getItem('preferred-lang') || 'ko';
  }

  function setLang(lang) {
    localStorage.setItem('preferred-lang', lang);
  }

  function filterSidebar(lang) {
    document.querySelectorAll('.book-summary li[data-lang]').forEach(function(li) {
      if (li.getAttribute('data-lang') === lang) {
        li.style.display = '';
      } else {
        li.style.display = 'none';
      }
    });
    // items without data-lang always show
    document.querySelectorAll('.book-summary li:not([data-lang])').forEach(function(li) {
      li.style.display = '';
    });
  }

  function updateToggleBtn(lang) {
    document.querySelectorAll('.lang-toggle-btn').forEach(function(btn) {
      btn.textContent = lang === 'ko' ? 'EN' : '한';
    });
  }

  function getPeer() {
    var meta = document.querySelector('meta[name="lang-peer"]');
    return meta ? meta.getAttribute('content') : null;
  }

  function injectButton() {
    var header = document.querySelector('.book-header');
    if (!header) return;
    if (document.querySelector('.lang-toggle-btn')) return;

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
      var current = getLang();
      var next = current === 'ko' ? 'en' : 'ko';
      setLang(next);
      var peer = getPeer();
      if (peer) {
        window.location.href = peer;
      } else {
        // no peer page — just filter sidebar
        filterSidebar(next);
        updateToggleBtn(next);
      }
    });

    header.style.position = 'relative';
    header.appendChild(btn);
  }

  document.addEventListener('DOMContentLoaded', function() {
    var lang = getLang();
    injectButton();
    updateToggleBtn(lang);
    filterSidebar(lang);
  });
})();
