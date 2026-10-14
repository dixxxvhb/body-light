// Runs PoseLandmarker off the main thread so tracking never costs a render frame.
// Frames arrive as ImageBitmaps; results go back as plain landmark arrays.

// tasks-vision loads its wasm glue with importScripts, which module workers
// do not allow. A synchronous fetch + global eval does the same job.
self.importScripts = (url) => {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', String(url), false);
  xhr.send();
  if (xhr.status >= 400) throw new Error(`Could not load ${url}`);
  (0, eval)(xhr.responseText);
};

let landmarker = null;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision');
      const fileset = await FilesetResolver.forVisionTasks(m.wasm);
      const make = (delegate) => PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: m.model, delegate },
        runningMode: 'VIDEO',
        numPoses: m.maxBodies,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      let delegate = 'GPU';
      try { landmarker = await make('GPU'); } catch { delegate = 'CPU'; landmarker = await make('CPU'); }
      self.postMessage({ type: 'ready', delegate });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message || err) });
    }
  } else if (m.type === 'frame') {
    const t0 = performance.now();
    let landmarks = [];
    try {
      landmarks = landmarker.detectForVideo(m.bitmap, m.ts).landmarks;
    } catch (err) {
      self.postMessage({ type: 'warn', message: String(err?.message || err) });
    }
    m.bitmap.close();
    self.postMessage({ type: 'result', landmarks, t: m.t, ms: performance.now() - t0 });
  }
};
