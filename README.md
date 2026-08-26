<h1 align="center"> 🍍 DatasetCreator 🍍 </h1>

<p align="center">
  <img src="https://img.shields.io/github/repo-size/TimCixo/DatasetCreator">
  <img src="https://img.shields.io/github/license/TimCixo/DatasetCreator">
  <img src="https://img.shields.io/github/last-commit/TimCixo/DatasetCreator">
</p>
<p align="center">
  <img src="https://img.shields.io/badge/react-18-61DAFB?logo=react">
  <img src="https://img.shields.io/badge/typescript-5-3178C6?logo=typescript&logoColor=white">
  <img src="https://img.shields.io/badge/vite-8-9135FF?logo=vite">
  <img src="https://img.shields.io/badge/tailwindcss-3-06B6D4?logo=tailwindcss">
  <img src="https://img.shields.io/badge/zustand-state-443E38">
  <img src="https://img.shields.io/badge/ONNX%20Runtime-Web-005CED">
  <img src="https://img.shields.io/badge/local--first-browser-2EA44F">
</p>

DatasetCreator is a local-first web app for preparing image datasets for Stable Diffusion training. It provides a browser workspace for importing assets, reviewing duplicates and similarity, editing images with Photopea, captioning with manual or local ONNX tags, and exporting ready-to-train PNG and TXT pairs.

## Overview

The project is built around a shared image workspace instead of a required backend. Users can import files, folders, or ZIP archives; organize assets in an Explorer; open tools and files in tabs; create dataset manifests; review image, video, and PSD assets; caption the final set; and export training files from the browser.

DatasetCreator uses React 18, TypeScript, Vite, Tailwind CSS, Zustand, JSZip, Lucide React, Radix UI, Photopea integration, and ONNX Runtime Web. Project state is browser-first, with IndexedDB-backed persistence and File System Access API support where available.

## Features

- File, folder, drag-and-drop, and ZIP import for local project assets.
- Supported assets: BMP, GIF, JPEG/JPG, PNG, WebP, TXT, JSON, PSD, MP4, and WebM.
- Workspace shell with Explorer, Inspector, Output panel, draggable tabs, and floating inspector.
- Project directory support with `manifest.json`, cached previews, and auto-save.
- Dataset manifests stored as `*.dataset.json` files.
- Similarity review for finding duplicate or near-duplicate images.
- Analysis views for image relationships, pairs, clusters, and graph layout.
- Photopea-based editing for workspace images and PSD files.
- Review stage for image, video, and PSD assets with active/inactive export status.
- Manual and bulk caption editing before export.
- Local Danbooru-style ONNX auto-tagging from user-selected model files.
- Training-ready export as matching PNG and TXT file pairs.
- ZIP export plus direct directory export in browsers that support `showDirectoryPicker`.
- Static build suitable for GitHub Pages and other static hosts.

## Screenshots

Screenshots can be added here when repository assets are available.

```text
docs/screenshots/import.png
docs/screenshots/tagging.png
```

## Installation

1. Install the required tooling:
   - Node.js 20 is recommended;
   - npm;
   - a modern desktop browser.

2. Clone the repository:

```bash
git clone https://github.com/TimCixo/DatasetCreator.git
cd DatasetCreator
```

3. Install dependencies:

```bash
npm install
```

4. Build the project when preparing a production bundle:

```bash
npm run build
```

## Usage

Run the Vite development server:

```bash
npm run dev
```

Open the local Vite URL in a browser, usually:

```text
http://localhost:5173/DatasetCreator/
```

Use the workspace tools in order:

1. Import images and project assets from files, folders, or ZIP archives.
2. Review duplicate and similarity groups.
3. Edit images or PSD files through the Photopea tool.
4. Analyze image relationships when needed.
5. Review the final dataset assets.
6. Create or open `*.dataset.json` files and add assets to them.
7. Add manual, bulk, or local ONNX-generated captions.
8. Export PNG images with matching TXT prompts as a ZIP or into a directory.

For the local auto-tagger, select files or a folder that contains:

```text
model.onnx
selected_tags.csv
```

Compatible tagger models should use the WD/Danbooru-style `selected_tags.csv` format used by SmilingWolf tagger models. Model access is session-based unless the browser can persist file handles, so reconnecting the files may be required after a reload.

Preview a production build locally:

```bash
npm run preview
```

## Project Structure

```mermaid
---
config:
    theme: default
    themeVariables:
        treeView:
            labelColor: '#717171'
            lineColor: '#717171'
    treeView:
        showIcons: true
---
treeView-beta

dataset-creator/
  package.json ## scripts and dependencies
  vite.config.ts
  tailwind.config.ts
  components.json
  public/
  src/ ## application source
    App.tsx
    main.tsx
    components/
      ToolHub.tsx
      InternalFileViewer.tsx
      photopea/ ## Photopea iframe integration
      stages/ ## workspace tools
        import
        remove duplicates
        Photopea editing
        analysis
        review
        tagging
        export
      ui/
    lib/ ## workspace asset and preview helpers
    services/ ## browser workflow logic
      cleanup/
      export/
      image/
      import/
      logging/
      persistence/
      project/
      psd/
      similarity/
      tagging/
    stores/ ## Zustand state stores
      project state
      UI state
      local tagger state
    types/ ## shared TypeScript models
```

## Configuration

DatasetCreator is a static client-side application. The main workflow does not require a backend or server-side configuration.

The Vite configuration lives in `vite.config.ts`. The current base path is:

```ts
base: '/DatasetCreator/'
```

Styling is configured through `tailwind.config.ts`, `postcss.config.js`, `src/index.css`, and `src/App.css`. UI component metadata is kept in `components.json`.

Browser storage is handled by the persistence service under `src/services/persistence`. Project directory reads and writes use the File System Access API where supported. For reliable local folder access and model loading, use `localhost` during development or HTTPS in hosted environments.

Project directories are stored with a `manifest.json`, app-managed cache data, imported assets, and optional `*.dataset.json` files. Dataset exports write matching `.png` and `.txt` files, with the dataset trigger word inserted at export time.

The local auto-tagger expects `model.onnx` and `selected_tags.csv`. ONNX Runtime Web is used for local inference.

## Development

- Runtime: static browser application served by Vite.
- Frontend: React 18 with TypeScript.
- Styling: Tailwind CSS 3 with local CSS layers.
- State: Zustand stores for project, UI, and local tagger state.
- Image workflow: dedicated services for import, similarity, editing, review, tagging, project files, and export.
- Persistence: IndexedDB-backed browser storage and project-directory snapshots where supported.
- Tagging: ONNX Runtime Web for local model inference.

Recommended development flow:

1. Start the Vite dev server.
2. Work on one workspace tool at a time under `src/components/stages`.
3. Keep browser-processing behavior inside the relevant service folder.
4. Keep shared project state changes in the Zustand stores.
5. Run a production build before publishing.

Useful commands:

```bash
npm run dev
npm run build
npm run preview
```

`package.json` also defines `npm run lint`, but the repository currently has no ESLint configuration, so linting is not an active validation gate yet.

## Roadmap

```mermaid
timeline
    Import workflow : file, folder, ZIP, and project directory intake
    Review workflow : duplicate and similarity inspection
    Editing workflow : Photopea image and PSD editing
    Dataset workflow : dataset manifests and asset selection
    Tagging workflow : manual, bulk, and local ONNX captions
    Export workflow : PNG and TXT training pairs
```

## Development Board

```mermaid
---
config:
  kanban:
    ticketBaseUrl: 'https://github.com/TimCixo/DatasetCreator/issues/#TICKET#'
---
kanban
    backlog[Backlog]
    todo[Todo]
    inProgress[In Progress]
    testing[Testing]
    done[Done]
```

## Contributing

Contributions are welcome.

You can help by:
- reporting bugs;
- suggesting dataset workflow improvements;
- improving documentation;
- testing with different image formats, dataset sizes, and browser environments;
- submitting pull requests.

Before making large changes, please open an issue first to discuss the idea.

## License

MIT. See [LICENSE](LICENSE).

## Credits

Created by [TimCixo](https://github.com/TimCixo).

Built for local-first Stable Diffusion dataset preparation workflows.
