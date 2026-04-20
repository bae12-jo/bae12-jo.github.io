(function() {
  document.addEventListener('DOMContentLoaded', function() {
    var bodyInner = document.querySelector('.body-inner') || document.querySelector('.page-inner');
    if (!bodyInner) return;

    var tocLinks = null;

    function getTocLinks() {
      if (!tocLinks) {
        tocLinks = Array.from(document.querySelectorAll('.book-summary a[href*="#"]'));
      }
      return tocLinks;
    }

    function getHeadings() {
      return Array.from(document.querySelectorAll('.page-inner h1[id], .page-inner h2[id], .page-inner h3[id]'));
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
        var href = a.getAttribute('href') || '';
        var hash = href.split('#')[1];
        var li = a.closest('li');
        if (!li) return;
        if (hash && hash === currentId) {
          li.classList.add('active');
          // scroll sidebar to keep active item visible
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

    var scrollEl = document.querySelector('.body-inner') || window;
    scrollEl.addEventListener('scroll', syncToc);
    setTimeout(syncToc, 300); // wait for TOC render
  });
})();
