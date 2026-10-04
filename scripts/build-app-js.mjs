#!/usr/bin/env node
// Builds the app's generated browser files: public/v2/core.js and public/v2/app.js.
// Edit the sources (public/v2/features and @trebuchet/core), never the generated
// files. Kept under this name because `npm run build:js` and the pre-push hook call it.
import { buildV2Js } from './build-v2-js.mjs';

buildV2Js();
console.log('Built public/v2/core.js and public/v2/app.js');
