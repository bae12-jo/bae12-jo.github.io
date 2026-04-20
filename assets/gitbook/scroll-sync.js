(function() {
  function getHeadings() {
    return Array.from(document.querySelectorAll('.page-inner h1, .page-inner h2, .page-inner h3'));
  }

  function getTocLinks() {
    return Array.from(document.querySelectorAll('.book-summary .inner ul li a[href*="#"]'));
  }

  function syncToc() {
    var headings = getHeadings();
    if (!headings.length) return;

    var scrollTop = document.querySelector('.body-inner')
      ? document.querySelector('.body-inner').scrollTop
      : window.scrollY;

    var current = null;
    for (var i = 0; i < headings.length; i++) {
      if (headings[i].offsetTop - 80 <= scrollTop) {
        current = headings[i];
      } else {
        break;
      }
    }

    if (!current) current = headings[0];
    var id = current.id;

    getTocLinks().forEach(function(a) {
      var li = a.parentElement;
      if (a.getAttribute('href') === '#' + id) {
        li.classList.add('active');
        // scroll toc item into view
        var summary = document.querySelector('.book-summary nav');
        if (summary) {
          var liTop = li.offsetTop;
          var summaryH = summary.clientHeight;
          if (liTop < summary.scrollTop || liTop > summary.scrollTop + summaryH - 40) {
            summary.scrollTop = liTop - summaryH / 2;
          }
        }
      } else {
        li.classList.remove('active');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', function() {
    var bodyInner = document.querySelector('.body-inner');
    var target = bodyInner || window;
    target.addEventListener('scroll', syncToc);
    syncToc();
  });
})();
