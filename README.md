# SuperGuider

SuperGuider is a Windows desktop assistant prototype for low-interruption task guidance.

It provides a Tauri desktop shell with a task-focused status panel, settings panel, lightweight notification orb, local state persistence, and Windows foreground-window inspection.

## Development

Install dependencies:

```bash
npm install
```

Build the frontend:

```bash
npm run build
```

Check the Tauri/Rust side:

```bash
cd src-tauri
cargo check
```

Run the desktop app:

```bash
npm run tauri dev
```
