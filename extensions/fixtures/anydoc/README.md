# AnyDoc native office-preview fixtures

One minimal, real document per strict Office format, used by the
in-process AnyDoc conversion tests and the `file_read` route tests.

All ten files are copied verbatim from `firecrawl/anydoc`
`tests/fixtures/` at the crate's reviewed release. The upstream
repository is MIT-licensed, which covers these committed test
documents.

| Fixture | Source path | Format |
| --- | --- | --- |
| `text.doc` | `tests/fixtures/doc/text.doc` | Binary Word 97-2003 |
| `text.docx` | `tests/fixtures/docx/text.docx` | WordprocessingML |
| `text.rtf` | `tests/fixtures/rtf/text.rtf` | Rich Text Format |
| `text.odt` | `tests/fixtures/odt/text.odt` | OpenDocument Text |
| `pres.ppt` | `tests/fixtures/ppt/pres.ppt` | Binary PowerPoint 97-2003 |
| `pres.pptx` | `tests/fixtures/pptx/pres.pptx` | PresentationML |
| `pres.odp` | `tests/fixtures/odp/pres.odp` | OpenDocument Presentation |
| `sheet.xls` | `tests/fixtures/xls/sheet.xls` | Legacy OLE Excel |
| `sheet.xlsx` | `tests/fixtures/xlsx/sheet.xlsx` | SpreadsheetML |
| `sheet.ods` | `tests/fixtures/ods/sheet.ods` | OpenDocument Spreadsheet |

Provenance: https://github.com/firecrawl/anydoc (MIT), crate pinned at
`=0.2.4`. AnyDoc version bumps require re-verifying these fixtures
still convert (the conversion smoke test fails loudly otherwise).

## Checksums (SHA-256)

```text
6b5e859ad2591be8f1cbc0246d7e757fbc0ffa06e8ccd022a3e1612f67169df1  pres.odp
8b92d2304598dafc977ff309095aa405151ac741d3374b3d5a214377b57765b3  pres.ppt
c96aa52da19f273f602040490203d9319872f512707e1a6c5a3fc53251b6d050  pres.pptx
e2c092eb2173b9c7ea8dd2c42e8dd7ef284cf37de40e206f3c8e43571de88454  sheet.ods
1b3fc8f35f4c7ad6bb4dcf9b9f1fdf4ddf1f4c7f2f6748f33b7948204f940136  sheet.xls
ddfec7c1e98c7b50611b1c3ac55c0aa0d9d413135aa7afc36732338e44f4d26c  sheet.xlsx
0d7c077cf4b49939a05ccd5f8012164649752be0c5841fa50da6258e0517e6e5  text.doc
6b674297884f9ed57809763c9f60ea3a849d5cc6fb28c9837c714e322eceddcf  text.docx
614b107dcd9f48364b33fa98ad1db32b43667701adeb510b081961ced54438ee  text.odt
8af25d8d79f898c5fd8c65782a6b73b04b4869fe621c6d39bf201ce4478ec731  text.rtf
```
