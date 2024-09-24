// Simple XML builder
function XMLBuilder() {
  this.xml = '';
  this.append = function (str) { this.xml += str; };
  this.toString = function () { return this.xml; };
}

// Basic authentication middleware
async function authenticate(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="WebDAV Server"' }
    });
  }

  const credentials = atob(authHeader.split(' ')[1]);
  const [username, password] = credentials.split(':');

  if (username !== env.AUTH_USERNAME || password !== env.AUTH_PASSWORD) {
    return new Response('Unauthorized', { status: 401 });
  }

  return null; // Authentication successful
}

// Check if a path is a directory
async function isDirectory(env, path) {
  if (path.endsWith('/')) return true;

  // Check if there's a directory marker
  const dirMarker = await env.MY_BUCKET.head(path + '/.dir');
  if (dirMarker !== null) return true;

  // Check if there are any objects with this path as a prefix
  const listed = await env.MY_BUCKET.list({ prefix: path + '/', delimiter: '/', limit: 5 });
  return listed.objects.length > 0 || listed.delimitedPrefixes.length > 0;
}

// PROPFIND method implementation
async function handlePROPFIND(path, depth, env) {
  const xml = new XMLBuilder();
  xml.append('<?xml version="1.0" encoding="utf-8"?>\n');
  xml.append('<D:multistatus xmlns:D="DAV:">\n');

  // Ensure path ends with '/' for consistency if it's a directory
  const isDir = await isDirectory(env, path);
  if (isDir && !path.endsWith('/')) path += '/';

  // Always include the requested path itself
  await appendResourceXML(xml, path, isDir, env);

  if (depth !== '0' && isDir) {
    const objects = await env.MY_BUCKET.list({ prefix: path, limit: 10 });
    for (const obj of objects.objects) {
      if (obj.key !== path) {
        const objIsDir = await isDirectory(env, obj.key);
        await appendResourceXML(xml, obj.key, objIsDir, env);
      }
    }
  }

  xml.append('</D:multistatus>');

  return new Response(xml.toString(), {
    status: 207,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' }
  });
}

async function appendResourceXML(xml, path, isDirectory, env) {
  let objDetails = null;

  if (!isDirectory) {
    objDetails = await env.MY_BUCKET.head(path);
  }

  xml.append('  <D:response>\n');
  xml.append(`    <D:href>${escapeXml(path)}</D:href>\n`);
  xml.append('    <D:propstat>\n');
  xml.append('      <D:prop>\n');
  xml.append('        <D:resourcetype>\n');
  if (isDirectory) {
    xml.append('          <D:collection/>\n');
  }
  xml.append('        </D:resourcetype>\n');
  if (!isDirectory && objDetails) {
    xml.append(`        <D:getcontentlength>${objDetails.size}</D:getcontentlength>\n`);
    xml.append(`        <D:getlastmodified>${new Date(objDetails.uploaded).toUTCString()}</D:getlastmodified>\n`);
    xml.append(`        <D:getetag>"${objDetails.httpEtag}"</D:getetag>\n`);
    xml.append(`        <D:getcontenttype>${objDetails.httpMetadata.contentType || 'application/octet-stream'}</D:getcontenttype>\n`);
  }
  xml.append('      </D:prop>\n');
  xml.append('      <D:status>HTTP/1.1 200 OK</D:status>\n');
  xml.append('    </D:propstat>\n');
  xml.append('  </D:response>\n');
}

// Helper function to handle file operations
async function handleFileOperation(env, path, operation) {
  const object = await env.MY_BUCKET.get(path);
  if (object === null) {
    return new Response('Not Found', { status: 404 });
  }
  return operation(object);
}

// Helper function to escape XML special characters
function escapeXml(unsafe) {
  return unsafe.replace(/[<>&'"]/g, function (c) {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}

// Main WebDAV request handler
async function handleWebDAV(request, env) {
  // Authentication
  const authResponse = await authenticate(request, env);
  if (authResponse) return authResponse;

  const url = new URL(request.url);
  let path = decodeURIComponent(url.pathname);

  try {
    switch (request.method) {
      case 'OPTIONS':
        return new Response(null, {
          headers: {
            'Allow': 'OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, PROPFIND, PROPPATCH, MOVE, COPY',
            'DAV': '1, 2',
            'MS-Author-Via': 'DAV'
          }
        });

      case 'GET':
        const isDir = await isDirectory(env, path);
        if (isDir) {
          // This is a directory request, return a directory listing
          return handlePROPFIND(path, '1', env);
        }
        return handleFileOperation(env, path, (object) =>
          new Response(object.body, {
            headers: {
              'Content-Type': object.httpMetadata.contentType || 'application/octet-stream',
              'Content-Length': object.size,
              'ETag': object.httpEtag,
              'Last-Modified': object.uploaded.toUTCString()
            }
          })
        );

      case 'PUT':
        const contentLength = request.headers.get('Content-Length');
        await env.MY_BUCKET.put(path, request.body, {
          httpMetadata: {
            contentType: request.headers.get('Content-Type') || 'application/octet-stream'
          }
        });
        return new Response(null, {
          status: 201,
          headers: {
            'Content-Length': '0',
            'ETag': `"${Date.now().toString(16)}"`
          }
        });

      case 'DELETE':
        await env.MY_BUCKET.delete(path);
        return new Response(null, { status: 204 });

      case 'MKCOL':
        if (!path.endsWith('/')) {
          path += '/';
        }
        await env.MY_BUCKET.put(path + '.dir', '');
        return new Response(null, { status: 201 });

      case 'PROPFIND':
        const depth = request.headers.get('Depth') || 'infinity';
        return handlePROPFIND(path, depth, env);

      case 'MOVE':
        const destination = request.headers.get('Destination');
        if (!destination) {
          return new Response('Bad Request: Missing Destination header', { status: 400 });
        }
        const destinationPath = new URL(destination).pathname;
        return handleFileOperation(env, path, async (object) => {
          await env.MY_BUCKET.put(destinationPath, object.body, {
            httpMetadata: object.httpMetadata
          });
          await env.MY_BUCKET.delete(path);
          return new Response(null, { status: 201 });
        });

      case 'COPY':
        const copyDestination = request.headers.get('Destination');
        if (!copyDestination) {
          return new Response('Bad Request: Missing Destination header', { status: 400 });
        }
        const copyDestinationPath = new URL(copyDestination).pathname;
        return handleFileOperation(env, path, async (object) => {
          await env.MY_BUCKET.put(copyDestinationPath, object.body, {
            httpMetadata: object.httpMetadata
          });
          return new Response(null, { status: 201 });
        });

      default:
        return new Response('Method Not Allowed', { status: 405 });
    }
  } catch (error) {
    console.error('Error in WebDAV handler:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

export default {
  async fetch(request, env) {
    return handleWebDAV(request, env);
  }
};
