// Language Switcher Plugin
(function() {
    console.log('[Language Switcher] Initializing...');
    
    // Check if we're using RequireJS or plain script
    if (typeof require !== 'undefined') {
        require(['gitbook', 'jquery'], function(gitbook, $) {
            initLanguageSwitcher(gitbook, $);
        });
    } else {
        // Fallback for when RequireJS is not available
        document.addEventListener('DOMContentLoaded', function() {
            if (typeof gitbook !== 'undefined' && typeof jQuery !== 'undefined') {
                initLanguageSwitcher(gitbook, jQuery);
            }
        });
    }
    
    function initLanguageSwitcher(gitbook, $) {
        console.log('[Language Switcher] GitBook and jQuery loaded');
        let currentLang = localStorage.getItem('preferredLang') || 'ko';
        
        function filterPostsByLanguage(lang) {
            console.log('[Language Switcher] Filtering posts for language:', lang);
            let count = 0;
            $('.chapter[data-lang]').each(function() {
                const postLang = $(this).attr('data-lang');
                if (postLang === lang || !postLang) {
                    $(this).show();
                    count++;
                } else {
                    $(this).hide();
                }
            });
            console.log('[Language Switcher] Visible posts:', count);
        }
        
        function updateDropdownSelection() {
            $('.lang-option').removeClass('selected');
            $('.lang-option[data-lang="' + currentLang + '"]').addClass('selected');
        }
        
        function createDropdown() {
            console.log('[Language Switcher] Creating dropdown');
            if ($('.lang-switcher-dropdown').length === 0) {
                const dropdown = $('<div class="lang-switcher-dropdown">' +
                    '<div class="lang-option" data-lang="ko">🇰🇷 한국어</div>' +
                    '<div class="lang-option" data-lang="en">🇺🇸 English</div>' +
                    '</div>');
                
                $('.book-header').append(dropdown);
                console.log('[Language Switcher] Dropdown appended to .book-header');
                
                // Add click handlers for language options
                $('.lang-option').on('click', function() {
                    currentLang = $(this).attr('data-lang');
                    console.log('[Language Switcher] Language changed to:', currentLang);
                    localStorage.setItem('preferredLang', currentLang);
                    updateDropdownSelection();
                    filterPostsByLanguage(currentLang);
                    $('.lang-switcher-dropdown').removeClass('active');
                });
                
                updateDropdownSelection();
                filterPostsByLanguage(currentLang);
            }
        }
        
        gitbook.events.bind('start', function() {
            console.log('[Language Switcher] GitBook start event');
            
            // Add language switcher button to toolbar
            gitbook.toolbar.createButton({
                icon: 'fa fa-globe',
                label: 'Language',
                position: 'left',
                className: 'lang-switcher-btn',
                onClick: function(e) {
                    e.preventDefault();
                    console.log('[Language Switcher] Button clicked');
                    $('.lang-switcher-dropdown').toggleClass('active');
                }
            });
            
            console.log('[Language Switcher] Button created');
            
            // Add dropdown menu after a delay to ensure DOM is ready
            setTimeout(createDropdown, 500);
            
            // Close dropdown when clicking outside
            $(document).on('click', function(e) {
                if (!$(e.target).closest('.lang-switcher-btn, .lang-switcher-dropdown').length) {
                    $('.lang-switcher-dropdown').removeClass('active');
                }
            });
        });
        
        gitbook.events.bind('page.change', function() {
            console.log('[Language Switcher] Page change event');
            setTimeout(function() {
                filterPostsByLanguage(currentLang);
                updateDropdownSelection();
                // Recreate dropdown if it doesn't exist
                if ($('.lang-switcher-dropdown').length === 0) {
                    createDropdown();
                }
            }, 300);
        });
    }
})();
