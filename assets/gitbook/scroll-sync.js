(function() {
  var scrollBound = false;

  function getHeadings() {
    return Array.from(document.querySelectorAll('.page-inner h1[id], .page-inner h2[id], .page-inner h3[id]'));
  }

  function getTocLinks() {
    return Array.from(document.querySelectorAll('.book-summary a[href*="#"]'));
  }

  function syncToc() {
    var headings = getHeadings();
    var links = getTocLinks();
    if (!headings.length || !links.length) return;

    var scrollEl = document.querySelector('.body-inner') || window;
    var scrollTop = scrollEl === window ? window.scrollY : scrollEl.scrollTop;

    var current = headings[0];
    for (var i = 0; i < headings.length; i++) {
      if (headings[i].offsetTop - 100 <= scrollTop) {
        current = headings[i];
      } else {
        break;
      }
    }

    var currentId = current ? current.id : null;
    links.forEach(function(a) {
      var hash = (a.getAttribute('href') || '').split('#')[1];
      var li = a.closest('li');
      if (!li) return;
      if (hash && hash === currentId) {
        li.classList.add('active');
        var nav = document.querySelector('.book-summary nav');
        if (nav) {
          var liTop = li.offsetTop;
          var navH = nav.clientHeight;
          if (liTop < nav.scrollTop || liTop > nav.scrollTop + navH - 60) {
            nav.scrollTop = liTop - navH / 2;
          }
        }
      } else {
        li.classList.remove('active');
      }
    });
  }

  function init() {
    if (scrollBound) return;
    var scrollEl = document.querySelector('.body-inner') || window;
    scrollEl.addEventListener('scroll', syncToc);
    scrollBound = true;
    setTimeout(syncToc, 300);
  }

  document.addEventListener('DOMContentLoaded', init);

  // GitBook SPA: rebind on page change
  function bindGitbook() {
    if (typeof gitbook !== 'undefined') {
      gitbook.events.bind('page.change', function() {
        scrollBound = false;
        setTimeout(init, 300);
      });
    }
  }

  document.addEventListener('DOMContentLoaded', function() {
    bindGitbook();
    if (typeof gitbook === 'undefined') setTimeout(bindGitbook, 1000);
  });
})();
