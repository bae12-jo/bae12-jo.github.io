// Language Switcher Plugin
require(['gitbook', 'jquery'], function(gitbook, $) {
    let currentLang = localStorage.getItem('preferredLang') || 'ko';
    
    function filterPostsByLanguage(lang) {
        $('.chapter[data-lang]').each(function() {
            const postLang = $(this).attr('data-lang');
            if (postLang === lang || !postLang) {
                $(this).show();
            } else {
                $(this).hide();
            }
        });
    }
    
    function updateDropdownSelection() {
        $('.lang-option').removeClass('selected');
        $('.lang-option[data-lang="' + currentLang + '"]').addClass('selected');
    }
    
    gitbook.events.bind('start', function(e, config) {
        // Add language switcher button to toolbar
        gitbook.toolbar.createButton({
            icon: 'fa fa-globe',
            label: 'Language',
            position: 'left',
            className: 'lang-switcher-btn',
            onClick: function(e) {
                e.preventDefault();
                $('.lang-switcher-dropdown').toggleClass('active');
            }
        });
        
        // Add dropdown menu to body
        setTimeout(function() {
            if ($('.lang-switcher-dropdown').length === 0) {
                const dropdown = $('<div class="lang-switcher-dropdown">' +
                    '<div class="lang-option" data-lang="ko">🇰🇷 한국어</div>' +
                    '<div class="lang-option" data-lang="en">🇺🇸 English</div>' +
                    '</div>');
                
                $('.book-header').append(dropdown);
                
                // Add click handlers for language options
                $('.lang-option').on('click', function() {
                    currentLang = $(this).attr('data-lang');
                    localStorage.setItem('preferredLang', currentLang);
                    updateDropdownSelection();
                    filterPostsByLanguage(currentLang);
                    $('.lang-switcher-dropdown').removeClass('active');
                });
                
                updateDropdownSelection();
                filterPostsByLanguage(currentLang);
            }
        }, 100);
        
        // Close dropdown when clicking outside
        $(document).on('click', function(e) {
            if (!$(e.target).closest('.lang-switcher-btn, .lang-switcher-dropdown').length) {
                $('.lang-switcher-dropdown').removeClass('active');
            }
        });
    });
    
    gitbook.events.bind('page.change', function() {
        setTimeout(function() {
            filterPostsByLanguage(currentLang);
            updateDropdownSelection();
        }, 100);
    });
});
