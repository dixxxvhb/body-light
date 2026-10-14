// Copies MediaPipe's wasm runtime into public/ so the app works offline and on Pages.
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('public/wasm', { recursive: true });
cpSync('node_modules/@mediapipe/tasks-vision/wasm', 'public/wasm', { recursive: true });
