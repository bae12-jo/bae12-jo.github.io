(function() {
  function getLang() {
    var meta = document.querySelector('meta[name="page-lang"]');
    if (meta && meta.getAttribute('content')) return meta.getAttribute('content');
    return localStorage.getItem('preferred-lang') || 'ko';
  }

  function setLang(lang) {
    localStorage.setItem('preferred-lang', lang);
  }

  function filterSidebar(lang) {
    document.querySelectorAll('.book-summary li[data-lang]').forEach(function(li) {
      li.style.display = li.getAttribute('data-lang') === lang ? '' : 'none';
    });
  }

  function updateBtn(lang) {
    document.querySelectorAll('.lang-toggle-btn').forEach(function(btn) {
      btn.textContent = lang === 'ko' ? 'EN' : '한';
    });
  }

  function getPeer() {
    var meta = document.querySelector('meta[name="lang-peer"]');
    return meta ? meta.getAttribute('content') : null;
  }

  // ---------- Sidebar state ----------
  function getSidebarOpen() {
    return document.querySelector('.book') &&
           document.querySelector('.book').classList.contains('with-summary');
  }

  function setSidebarOpen(open) {
    var book = document.querySelector('.book');
    if (!book) return;
    if (open) {
      book.classList.add('with-summary');
    } else {
      book.classList.remove('with-summary');
    }
  }

  // Save which .chapter li elements have the 'expanded' class (expandable-chapters state)
  function getExpandedChapters() {
    var expanded = [];
    document.querySelectorAll('.book-summary li.chapter.expanded').forEach(function(li) {
      expanded.push(li.getAttribute('data-path') || '');
    });
    return expanded.join(',');
  }

  function restoreExpandedChapters(paths) {
    if (!paths) return;
    var list = paths.split(',').filter(Boolean);
    document.querySelectorAll('.book-summary li.chapter').forEach(function(li) {
      if (list.indexOf(li.getAttribute('data-path') || '') !== -1) {
        li.classList.add('expanded');
      }
    });
  }

  // ---------- Scroll & hash ----------
  function getScrollInfo() {
    // Return current hash (section anchor) + raw scrollTop as fallback
    var hash = window.location.hash || '';
    var el = document.querySelector('.body-inner') || document.querySelector('.page-inner');
    var top = el ? el.scrollTop : window.scrollY;
    return { hash: hash, top: top };
  }

  function restoreScroll(hash, top) {
    // Prefer hash-based navigation (same section heading on peer page)
    if (hash) {
      var target = document.querySelector(hash);
      if (target) {
        setTimeout(function() {
          var container = document.querySelector('.body-inner') || document.querySelector('.page-inner');
          if (container) {
            container.scrollTop = target.offsetTop - 20;
          } else {
            target.scrollIntoView();
          }
        }, 300);
        return;
      }
    }
    // Fallback: restore raw scroll position
    var el = document.querySelector('.body-inner') || document.querySelector('.page-inner');
    setTimeout(function() {
      if (el) { el.scrollTop = top; }
      else { window.scrollTo(0, top); }
    }, 300);
  }

  // ---------- Button ----------
  function injectButton() {
    if (document.querySelector('.lang-toggle-btn')) return;
    var header = document.querySelector('.book-header');
    if (!header) return;

    var btn = document.createElement('a');
    btn.className = 'lang-toggle-btn';
    btn.href = '#';
    btn.style.cssText = 'position:absolute;right:66px;top:0;line-height:50px;padding:0 12px;font-size:13px;font-weight:bold;color:inherit;text-decoration:none;z-index:10;';

    btn.addEventListener('click', function(e) {
      e.preventDefault();
      var current = getLang();
      var next = current === 'ko' ? 'en' : 'ko';
      setLang(next);

      var peer = getPeer();
      if (peer) {
        var scrollInfo = getScrollInfo();
        sessionStorage.setItem('restore-hash', scrollInfo.hash);
        sessionStorage.setItem('restore-scroll', scrollInfo.top);
        sessionStorage.setItem('restore-sidebar', getSidebarOpen() ? '1' : '0');
        sessionStorage.setItem('restore-expanded', getExpandedChapters());
        // Navigate to peer, preserving hash if any
        window.location.href = peer + scrollInfo.hash;
      } else {
        filterSidebar(next);
        updateBtn(next);
      }
    });

    header.style.position = 'relative';
    header.appendChild(btn);
  }

  // ---------- Restore ----------
  function restoreState() {
    var hash    = sessionStorage.getItem('restore-hash');
    var scroll  = sessionStorage.getItem('restore-scroll');
    var sidebar = sessionStorage.getItem('restore-sidebar');
    var expanded = sessionStorage.getItem('restore-expanded');

    if (scroll !== null || hash) {
      sessionStorage.removeItem('restore-hash');
      sessionStorage.removeItem('restore-scroll');
      restoreScroll(hash || '', parseInt(scroll || '0', 10));
    }
    if (sidebar !== null) {
      sessionStorage.removeItem('restore-sidebar');
      // Slight delay so gitbook layout settles first
      setTimeout(function() { setSidebarOpen(sidebar === '1'); }, 80);
    }
    if (expanded !== null) {
      sessionStorage.removeItem('restore-expanded');
      setTimeout(function() { restoreExpandedChapters(expanded); }, 150);
    }
  }

  // ---------- Init ----------
  function init() {
    var lang = getLang();
    injectButton();
    updateBtn(lang);
    filterSidebar(lang);
    restoreState();
  }

  document.addEventListener('DOMContentLoaded', init);

  function bindGitbook() {
    if (typeof gitbook !== 'undefined') {
      gitbook.events.bind('page.change', function() { setTimeout(init, 100); });
    }
  }

  document.addEventListener('DOMContentLoaded', function() {
    bindGitbook();
    if (typeof gitbook === 'undefined') setTimeout(bindGitbook, 1000);
  });

  var observer = new MutationObserver(function() {
    if (!document.querySelector('.lang-toggle-btn')) {
      setTimeout(init, 50);
    }
  });
  document.addEventListener('DOMContentLoaded', function() {
    var header = document.querySelector('.book-header');
    if (header) observer.observe(header, { childList: true, subtree: true });
  });
})();
