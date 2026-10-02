# V2 renderer sources

Edit the files in this folder, then run `npm run build:js`. Commit the source files and the generated `public/v2/app.js` and `public/v2/core.js` together. CI checks the generated output.

The folders group launch, wallet, recovery, discovery, proof, and page shell code. `scripts/build-v2-js.mjs` records their order. The feature files share the page scope and the existing `state` object. Keeping this scope preserves event handlers and startup order while allowing focused source edits.

Planning rules, costs, image validation, and proof contracts live in `@trebuchet/core/browser`. The build bundles that entry into `public/v2/core.js`, which the page loads before `app.js`. Node and the browser use the same Core sources. The page's Quick Launch cost preview, airdrop cost, and vanity estimate call Core functions.
