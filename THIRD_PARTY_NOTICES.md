# Third-party preview components

Arcelle 0.26.6 uses the following open-source components for local file previews.
No preview component in this release uses a paid, GPL, LGPL, or AGPL license.

| Component | Purpose | License | Source |
|---|---|---|---|
| ag-psd | PSD composite decoding | MIT | https://github.com/Agamnentzar/ag-psd |
| UTIF.js | TIFF decoding | MIT | https://github.com/photopea/UTIF.js |
| jSquash JPEG XL | JPEG XL decoding | Apache-2.0 | https://github.com/jamsinclair/jSquash |
| foliate-js | MOBI, AZW3, FB2 and CBZ reading | MIT | https://github.com/johnfactotum/foliate-js |
| libarchive.js | 7z, RAR, TAR and GZIP archive listing | MIT | https://github.com/nika-begiashvili/libarchivejs |
| libarchive | Archive parsing compiled into libarchive.js | BSD-2-Clause | https://github.com/libarchive/libarchive |
| @kenjiuno/msgreader | Outlook MSG parsing | Apache-2.0 | https://github.com/HiraokaHyperTools/msgreader |
| zetajs | JavaScript bridge for ZetaOffice | MIT | https://github.com/allotropia/zetajs |
| ZetaOffice | Optional offline office-to-PDF converter | MPL-2.0 | https://github.com/allotropia/zetaoffice |

The optional ZetaOffice runtime is downloaded only after explicit user consent.
Arcelle verifies the pinned SHA-256 of every runtime artifact. The converter
runs locally after installation and does not upload documents.
