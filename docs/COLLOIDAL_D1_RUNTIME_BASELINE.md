# Colloidal Gold D1 Runtime Baseline

This research branch records the code for the `d1-local-candidate-v4-capture-defaults` pilot. It does not switch the production recognizer. The model bundle supplies the ONNX weights, the rule profiles, and the frozen optical core. Those artifacts, training data, photos, review notes, and private configuration are not in Git.

The internal Linux x86_64 / CPython 3.10 pilot archive is `colloidal-d1-server-pilot-v4.zip`. Its SHA-256 is `770c76731581dbb06274435b0be2bd782ff2726c517a3ca85b6ce218706df7a6`. Verify the outer archive checksum and the inner file manifest before running it. All nine inference and capture sources in the archive match the corresponding sources here byte for byte. The audit, read-only gallery, and generic packaging tool are supporting source.

Install the internal archive's pinned dependencies in its own directory, and run its capture server on loopback with a capture directory separate from the release. The pilot uses the selected project and original image; reference labels are kept for later comparison. Image interpretation is diagnostic and cannot produce a formal final business result. Start with one image at a time. Stop the pilot process to roll back and retain the test captures.

Verification at publication: archive checksum and manifest, no-PyTorch Mac CPU replay on one previously uploaded original photo, and 37 existing business integration contract tests. The target Linux host was surveyed but this candidate had not yet been started there. Neither phone access on the server path nor an authorized production workflow pilot is implied by this snapshot.
