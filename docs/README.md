# Kaguya Documentation

This directory contains the multilingual Kaguya documentation site, built with VitePress.

## Content layout

- `zh/` and `en/` contain matching Chinese and English routes.
- `.vitepress/config.mts` defines site-wide settings and localized navigation.
- `.vitepress/sidebar/` keeps each language's sidebar explicit and reviewable.
- `.vitepress/theme/` contains the shared visual theme.
- `public/` contains static assets.
- Existing MaiBot-derived pages remain in place for later review, but are excluded from the new site build.

## Local development

Run commands from this directory. Use the Node.js and pnpm versions declared by the repository.

::: code-group

```bash [Install] icon="logos:pnpm"
pnpm install
```

```bash [Preview] icon="logos:vitejs"
pnpm docs:dev
```

```bash [Build] icon="logos:vitepress"
pnpm docs:build
```

:::

The development server prints the local URL in the terminal. The production site is configured for the GitHub Pages base path `/Kaguya/`.

## Adding a page

1. Add the Markdown file to both `zh/` and `en/` using the same relative path.
2. Add the route to both localized sidebar files.
3. Keep headings descriptive so the right-hand page outline is useful.
4. Run the production build and inspect both languages locally.
