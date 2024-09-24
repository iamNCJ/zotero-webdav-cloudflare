# Zotero WebDAV Cloudflare Serverless
 A Serverless WebDAV Server on Cloudflare for Zotero Library Syncing

## Introduction
This is a simple serverless WebDAV server that can be deployed to Cloudflare Workers with data stored in Cloudflare R2 Object Storage. It is designed to be used with Zotero for syncing your library across devices.

> Disclaimers: 
> 1. I built the code with Claude, hence there might be some unnoticed bugs, although it has worked well so far.
> 2. This WebDAV server is not designed to be a full-featured WebDAV server. It is designed to be used with Zotero only.
> 3. Known issues: 
>   - `PROPFIND` will timeout on free tier Cloudflare Workers. Hence only first 10 items will be listed (but should still work with Zotero).
>   - A single user use case is assumed. Concurrent modification to the same file may cause issues.
>   - The maximum file size is limited to 100MB (Cloudflare Workers limit).

## Usage
1. Deploy the code to Cloudflare Workers.
2. Create a bucket in Cloudflare R2 Object Storage.
3. Link the bucket to the Worker with environment variable `MY_BUCKET`.
4. Set secret key (username & password) for the Worker with environment variables `AUTH_USERNAME` and `AUTH_PASSWORD`.
5. Set the worker's url in Zotero's WebDAV settings, e.g., `https://your-worker.your-subdomain.workers.dev/`. Also set the username and password to the secret key set in step 4.
6. Enjoy syncing your Zotero library across devices (with high-speed and unlimited space).
