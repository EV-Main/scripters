# Page

r[page.standalone]
The html MUST work as a single file opened from `file://`: no server, no CDN, no external reference. `watch` serves that same file; nothing in it may depend on being served.

r[page.md-truth]
The embedded md MUST be the only source of truth: an edit splices into it and reparses. Nothing serializes the graph back to md.
