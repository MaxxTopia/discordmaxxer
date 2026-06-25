/*
 * Discordmaxxer build plugin
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Resolves `import x from "<path>?raw"` to the raw text contents of the file,
 * including imports that resolve through a package's `exports` map (e.g.
 * "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?raw"). Used to inline an
 * AudioWorklet processor's source so it can be registered from a Blob URL at
 * runtime without shipping a separate asset file into the asar.
 */

import { Plugin } from "esbuild";
import { readFile } from "fs/promises";

export function rawPlugin(): Plugin {
    return {
        name: "raw-text",
        setup(build) {
            build.onResolve({ filter: /\?raw$/ }, async args => {
                const target = args.path.slice(0, -4); // strip "?raw"
                const resolved = await build.resolve(target, {
                    kind: args.kind,
                    importer: args.importer,
                    resolveDir: args.resolveDir
                });
                if (resolved.errors.length) return { errors: resolved.errors };
                return { path: resolved.path, namespace: "raw-text" };
            });

            build.onLoad({ filter: /.*/, namespace: "raw-text" }, async args => ({
                contents: await readFile(args.path, "utf8"),
                loader: "text"
            }));
        }
    };
}
