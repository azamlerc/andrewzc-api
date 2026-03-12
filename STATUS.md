# Status

Updated by Codex on March 12, 2026.

## Summary

Implemented the backend half of a new direct image upload workflow for the personal website.

## Changes Made Today

- Added admin-only image upload endpoints:
  - `POST /entities/:list/:key/images/presign`
  - `POST /entities/:list/:key/images/complete`
- Implemented server-side filename allocation based on the entity's existing `images` array.
- Presigned paired S3 uploads for:
  - original image at `<list>/<filename>`
  - thumbnail at `<list>/tn/<filename>`
- Added Mongo helper logic to append uploaded filenames safely to `entity.images`.
- Moved S3-specific logic out of `server.js` into `aws.js`.
- Updated the root `/` endpoint description to include the new image endpoints.
- Updated `README.md` to document:
  - new AWS-related env vars
  - `images` in the entity model
  - the new upload endpoint flow
- Added AWS SDK dependencies needed for S3 presigning.

## Result

The API now supports direct browser and CLI image uploads via presigned S3 URLs while keeping MongoDB as the source of truth for image association and ordering.
