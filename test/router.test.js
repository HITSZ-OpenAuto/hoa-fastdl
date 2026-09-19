import assert from 'node:assert';
import worker from '../src/index.js';

console.log('🧪 Running hoa-fastdl URLPattern router tests...');

// Mock Cloudflare Worker env
const env = {
  PREFIX: '/',
  WHITE_LIST: '',
  USE_JSDELIVR: '0',
  ALLOWED_ORIGINS: '*',
};

async function testRouteMatching() {
  const validUrls = [
    'https://fastdl.example.com/github.com/HITSZ-OpenAuto/hoa-fastdl/releases/download/v1.0/app.zip',
    'https://fastdl.example.com/github.com/HITSZ-OpenAuto/hoa-fastdl/archive/refs/heads/main.zip',
    'https://fastdl.example.com/github.com/HITSZ-OpenAuto/hoa-fuma/blob/main/README.md',
    'https://fastdl.example.com/github.com/HITSZ-OpenAuto/hoa-fuma/raw/main/README.md',
    'https://fastdl.example.com/github.com/HITSZ-OpenAuto/hoa-fuma/info/refs',
    'https://fastdl.example.com/github.com/HITSZ-OpenAuto/hoa-fuma/git-upload-pack',
    'https://fastdl.example.com/raw.githubusercontent.com/HITSZ-OpenAuto/hoa-fuma/main/package.json',
    'https://fastdl.example.com/raw.github.com/HITSZ-OpenAuto/hoa-fuma/main/package.json',
    'https://fastdl.example.com/gist.githubusercontent.com/user/gistid/raw/file.txt',
    'https://fastdl.example.com/gist.github.com/user/gistid/raw/file.txt',
    'https://fastdl.example.com/github.com/HITSZ-OpenAuto/hoa-fastdl/tags',
  ];

  for (const url of validUrls) {
    const request = new Request(url, { method: 'GET' });
    const response = await worker.fetch(request, env);
    const location = response.headers.get('location') || '';
    assert.strictEqual(
      location.includes('msg=resource') && location.includes('whitelist'),
      false,
      `Valid URL incorrectly rejected by router: ${url}`
    );
    console.log(`✅ Allowed route passed: ${url.replace('https://fastdl.example.com/', '')}`);
  }

  const invalidUrls = [
    'https://fastdl.example.com/google.com/search',
    'https://fastdl.example.com/github.com/unsupported-path-only',
    'https://fastdl.example.com/malicious-site.com/hack',
  ];

  for (const url of invalidUrls) {
    const request = new Request(url, { method: 'GET' });
    const response = await worker.fetch(request, env);
    const location = response.headers.get('location') || '';
    assert.strictEqual(
      location.includes('code=403') && location.includes('whitelist'),
      true,
      `Invalid URL was NOT rejected: ${url}`
    );
    console.log(`✅ Rejected invalid route passed: ${url.replace('https://fastdl.example.com/', '')}`);
  }

  // Test jsDelivr redirect option
  const jsDelivrEnv = { ...env, USE_JSDELIVR: '1' };
  const blobReq = new Request('https://fastdl.example.com/github.com/owner/repo/blob/v1/file.js', { method: 'GET' });
  const blobRes = await worker.fetch(blobReq, jsDelivrEnv);
  assert.strictEqual(blobRes.status, 302);
  assert.strictEqual(blobRes.headers.get('location'), 'https://cdn.jsdelivr.net/gh/owner/repo@v1/file.js');
  console.log('✅ jsDelivr redirect for blob URLs passed');
}

testRouteMatching()
  .then(() => {
    console.log('\n🎉 All URLPattern router tests passed successfully!');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n❌ Test failed:', err);
    process.exit(1);
  });
