# Third-party notices

qb-td's own code is MIT (see `LICENSE`). This file covers the third-party
software it redistributes or interoperates with.

## MODAQ — MIT © 2020 Alejandro Lopez-Lago

The moderator reader page embeds
[MODAQ](https://github.com/alopezlago/MODAQ) (npm `modaq` 1.41.x), bundled
into `app/js/read.bundle.js` by esbuild. The bundle preserves the license
comments of MODAQ's own dependencies (React and others) in a
"Bundled license information" block at the end of the file. MODAQ's license:

> The MIT License (MIT)
>
> Copyright (c) 2020 Alejandro Lopez-Lago
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## YellowFruit — file-format interoperability only

The `.yft` export (`app/engine/yft.js`) writes files readable by
[YellowFruit](https://github.com/ANadig/YellowFruit) (AGPL-3.0). No
YellowFruit code is redistributed here: yft.js is an independent
implementation of the `.yft` JSON file format, whose structure and
snake_case key names were verified against YellowFruit 4.0.18 to ensure
the generated files open cleanly. The key names themselves follow the
community tournament-schema (qbj) conventions.

## External services and formats

- `.docx` packets are converted in the moderator's browser by the public
  YAPP service (quizbowlreader.com) — an external service, not code shipped
  here.
- Match files use the community
  [tournament schema](https://schema.quizbowl.technology/) (qbj) format.
- `app/engine/zip.js` is an original dependency-free ZIP reader/writer, not
  a vendored library.
