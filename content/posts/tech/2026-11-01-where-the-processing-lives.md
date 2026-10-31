---
title: 'Where the Processing Lives'
subtitle: 'Markdown CMS architecture — no database, no runtime server'
author: ミューズさん
date: '2026-11-01'
category: お知らせ
summary: 'Where does the code actually run in a website? A traditional CMS keeps a database and an application server working on every request. Markdown CMS removes both. This article walks through the architecture using the English slide deck: the three design pillars, the universal site-folder core, the five-stage lifecycle of an article, the OSS edition on GitHub and the Commercial edition on Cloudflare, and why the compute footprint approaches zero.'
cover: tech/processing-lives.webp
cover_alt: A press stamping a stack of documents into cards that fly to a browser window, while a server tower sleeps beside a bookshelf
type: article
---
Where does the processing live in a website?

In a traditional CMS, the answer is "on the server, all the time." A database holds the content, an application server assembles every page when it is requested, and both keep running whether anyone is reading or not. For a homepage that changes a few times a week, that is a lot of machinery standing by.

Markdown CMS takes the opposite approach: it removes the database and the runtime server entirely, and lets processing live only at the moment of publishing. This article explains the architecture, following the English slide deck.

## We removed the database and the runtime server

The comparison is simple. A legacy stack — WordPress being the familiar example — maintains a database and runs server-side rendering on every access. Markdown CMS keeps the source as plain Markdown files, generates JSON when something is published, and lets the browser assemble the page from pre-generated files.

The result is zero database maintenance, zero idle compute, and zero server-side rendering.

![Slide "We removed the database and the runtime server": a legacy stack with database and server-side rendering, compared with Markdown CMS with Markdown files, JSON on publish, and browser assembly](tech/processing-lives-removed.webp)

## Three pillars that eliminate operational gravity

The architecture rests on three structural decisions.

1. **Files = Truth**: No database holds the canonical copy. Authoritative content lives directly in the local file system as Markdown and assets, so an article can be carried anywhere as a file
2. **Pre-Generation**: All computation happens before the reader arrives. Builds produce static JSON, and delivery serves only pre-computed artifacts
3. **Browser Assembly**: The client fetches a lightweight JSON payload and assembles the DOM locally, instead of asking a server to render HTML on every request

![Slide "The three structural pillars": Files = Truth, Pre-Generation, and Browser Assembly](tech/processing-lives-pillars.webp)

## The universal core: a site folder

Whichever edition you choose, the core is identical: a folder.

- `posts/*.md` — articles as Markdown with metadata in frontmatter
- `assets/` — images and files, kept as files
- `scripts/build.py` — the transformer that reads the folder and emits the shared JSON format, `data.json`
- `index.html` + `app.js` — the reader, which displays the JSON

![Slide "The universal core": the site folder with posts, assets, build.py, and the reader app](tech/processing-lives-core.webp)

Because articles are normalized into the same folder format, existing sites can be brought in as well. A converter takes a WordPress site, or a hand-coded HTML site, and turns it into a site folder — after which it is maintained exactly like a site that started here.

## The lifecycle of a Markdown article

Every article crosses the same five stages: Edit, Store, Generate, Distribute, Display. The universal core never changes. What changes between editions is only the physical infrastructure each stage runs on.

![Slide "The lifecycle of a Markdown article": five stages from Edit to Display, with generation triggered on change](tech/processing-lives-lifecycle.webp)

## OSS edition: entirely on GitHub

The free edition runs on GitHub's existing infrastructure.

You edit in a local terminal, in VS Code or any editor. A `git push` stores the article in a GitHub repository. That push triggers GitHub Actions, which runs the build and generates the JSON. GitHub Pages distributes the static files, and the reader's browser fetches the JSON and renders it locally with app.js.

![Slide "OSS Edition: entirely on GitHub": User Terminal, GitHub Repo, GitHub Actions, GitHub Pages, User Browser](tech/processing-lives-oss.webp)

The OSS edition is MIT-licensed and published, with its [repository](https://github.com/oosawak/markdown-cms-oss) and [sample site](https://oosawak.github.io/markdown-cms-oss/).

## Commercial edition: on the Cloudflare edge

The Commercial edition removes GitHub from the reader-facing flow, so that people who do not use GitHub can still run a site.

An authenticated admin screen edits the article. Saving stores the Markdown and images in Cloudflare R2 and fires an event through Queues. A Worker runs the generation and converts Markdown into JSON. The Worker also distributes: it serves the last successful generation directly from R2 at the edge, injecting dynamic head and OGP tags per URL — that SEO mechanism is being implemented now. If a generation fails, the previous version simply stays live.

![Slide "Commercial Edition: on the Cloudflare Edge": Admin UI, Cloudflare R2, Cloudflare Workers, Cloudflare Edge, User Browser](tech/processing-lives-commercial.webp)

A GitHub-based variant is also kept in the Commercial edition: articles in a private repository are built and published by Cloudflare Pages. It is a separate destination from the R2 model, and the two are managed separately.

## Isolating the architectural variables

Placed side by side, the two editions differ in exactly four places.

| Variable | OSS edition | Commercial edition |
|---|---|---|
| Storage medium | GitHub repository (Git) | Cloudflare R2 (object storage) |
| Generation core | GitHub Actions (build.py) | Cloudflare Workers |
| Execution trigger | git push | PUT /save via the admin API |
| Edge delivery | GitHub Pages | Workers serving from R2 |
| Failure state | Last successful commit kept live | Last successful generation kept live |

![Slide "Isolating the architectural variables": the comparison table of the two editions](tech/processing-lives-compare.webp)

Underneath, the universal truths do not move: one file is one article, there is no database, there is no runtime server, and display is always app.js reading data.json.

## The compute footprint approaches absolute zero

In this architecture, a serverless function or a build runs only at the instant of a push or a publish action. It idles at true zero the rest of the time, and a page view triggers no computation at all — computing happens only when the content itself changes.

![Slide "The compute footprint approaches absolute zero": compute spikes at publish and returns to zero, while viewing stays at zero](tech/processing-lives-footprint.webp)

## Selecting your deployment pipeline

So which edition fits? If you are happy working in Git and want everything inspectable in one repository, the OSS edition on GitHub is enough. If the site should be editable from an admin screen, without GitHub, the Commercial edition on Cloudflare is the one.

Either way, the canonical source remains your own content as portable Markdown files. The infrastructure can change; the articles do not have to.

A Japanese companion article, [Seeing Markdown CMS in diagrams](https://oosawak.github.io/tech/#/ja/post/tech/architecture) (in Japanese), walks through the same architecture with the Japanese diagrams.
