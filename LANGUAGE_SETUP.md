# 언어 전환 기능 사용법 / Language Switcher Usage

## 개요 / Overview

블로그에 한국어/영어 언어 전환 기능이 추가되었습니다.
Language switcher for Korean/English has been added to the blog.

## 사용 방법 / How to Use

### 1. 포스트에 언어 속성 추가 / Add Language Attribute to Posts

각 포스트의 front matter에 `lang` 속성을 추가하세요:
Add `lang` attribute to the front matter of each post:

**한국어 포스트 / Korean Post:**
```yaml
---
title: 한국어 제목
lang: ko
---
```

**영어 포스트 / English Post:**
```yaml
---
title: English Title
lang: en
---
```

### 2. 언어 전환 버튼 / Language Switcher Buttons

- 우측 상단에 두 개의 버튼이 표시됩니다
- Two buttons appear in the top-right corner:
  - **한** : 한국어 포스트만 표시 / Show only Korean posts
  - **A** : 영어 포스트만 표시 / Show only English posts

### 3. 자동 저장 / Auto-save

- 선택한 언어는 브라우저에 자동 저장됩니다
- Selected language is automatically saved in browser
- 다음 방문 시 마지막 선택한 언어가 유지됩니다
- Last selected language persists on next visit

## 파일 구조 / File Structure

```
_includes/
  └── language-switcher.html    # 언어 전환 버튼 UI / Language switcher UI

_data/
  └── translations.yml           # UI 텍스트 번역 / UI text translations

_layouts/
  ├── home.html                  # 언어 전환 버튼 포함 / Includes switcher
  └── post.html                  # 언어 전환 버튼 포함 / Includes switcher

_includes/
  └── toc-date.html              # 언어 필터링 지원 / Language filtering support
```

## 기존 포스트 업데이트 / Update Existing Posts

기존 포스트에 언어 속성을 추가하려면:
To add language attribute to existing posts:

```bash
# 한국어 포스트
# Korean posts
---
title: 기존 제목
lang: ko
category: Jekyll
layout: post
---

# 영어 포스트
# English posts
---
title: Existing Title
lang: en
category: Jekyll
layout: post
---
```

## 커스터마이징 / Customization

### 버튼 스타일 변경 / Change Button Style

`_includes/language-switcher.html` 파일의 CSS를 수정하세요.
Edit CSS in `_includes/language-switcher.html` file.

### 버튼 위치 변경 / Change Button Position

```css
.language-switcher {
    position: fixed;
    top: 20px;      /* 상단 여백 / Top margin */
    right: 20px;    /* 우측 여백 / Right margin */
}
```

### 기본 언어 변경 / Change Default Language

`_includes/language-switcher.html`에서:
In `_includes/language-switcher.html`:

```javascript
let currentLang = localStorage.getItem('preferredLang') || 'ko';  // 'ko' 또는 'en'
```

## 주의사항 / Notes

- `lang` 속성이 없는 포스트는 모든 언어에서 표시됩니다
- Posts without `lang` attribute will be shown in all languages
- 언어 전환은 클라이언트 사이드에서 동작합니다 (JavaScript)
- Language switching works on client-side (JavaScript)
