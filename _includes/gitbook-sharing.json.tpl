            "sharing": {
                "facebook": false,
                "google": false,
                "twitter": false,
                "telegram": false,
                "instapaper": false,
                "vk": false,
                "weibo": false,

                "github": true,
              {% if site.github_username %}
                "github_link": "https://github.com/{{ site.github_username }}",
              {% elsif site.sharing.github_link %}
                "github_link": "{{ site.sharing.github_link }}",
              {% else %}
                "github_link": "https://github.com",
              {% endif %}

                "linkedin": true,
              {% if site.linkedin_username %}
                "linkedin_link": "https://www.linkedin.com/in/{{ site.linkedin_username }}",
              {% elsif site.sharing.linkedin_link %}
                "linkedin_link": "{{ site.sharing.linkedin_link }}",
              {% else %}
                "linkedin_link": "https://www.linkedin.com",
              {% endif %}

                "all": []
            },
