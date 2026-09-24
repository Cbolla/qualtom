const sharp = require('sharp');
const fs = require('fs');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1a1a2e"/>
      <stop offset="100%" style="stop-color:#0d0d1a"/>
    </linearGradient>
    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#00d4aa"/>
      <stop offset="100%" style="stop-color:#00b896"/>
    </linearGradient>
  </defs>
  <circle cx="128" cy="128" r="128" fill="url(#bg)"/>
  <path d="M128 32c-26.5 0-48 21.5-48 48v80c0 26.5 21.5 48 48 48s48-21.5 48-48V80c0-26.5-21.5-48-48-48z" fill="url(#accent)"/>
  <path d="M168 160c0 22.1-17.9 40-40 40s-40-17.9-40-40" fill="none" stroke="url(#accent)" stroke-width="12" stroke-linecap="round"/>
  <path d="M128 208c-17.7 0-32-14.3-32-32h64c0 17.7-14.3 32-32 32z" fill="url(#accent)"/>
  <g fill="none" stroke="url(#accent)" stroke-width="8" stroke-linecap="round" opacity="0.6">
    <path d="M176 96c0 17.7-14.3 32-32 32s-32-14.3-32-32"/>
    <path d="M200 72c0 27.7-22.3 48-48 48s-48-22.3-48-48"/>
  </g>
</svg>`;

async function generate() {
  await sharp(Buffer.from(svg))
    .resize(192, 192)
    .png()
    .toFile('public/pwa-192x192.png');

  await sharp(Buffer.from(svg))
    .resize(512, 512)
    .png()
    .toFile('public/pwa-512x512.png');

  await sharp(Buffer.from(svg))
    .resize(180, 180)
    .png()
    .toFile('public/apple-touch-icon.png');

  console.log('Icons generated successfully!');
}

generate().catch(console.error);