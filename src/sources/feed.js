'use strict';
/* A small Atom reader, enough for Reddit's and phpBB's public feeds. */

const { decodeEntities, htmlToText, oneLine } = require('../text');

function unwrap(s) {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s || '');
  return m ? m[1] : s || '';
}

function tag(block, name) {
  const m = new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i').exec(block);
  return m ? unwrap(m[1]) : '';
}

function attr(block, name, attribute) {
  const m = new RegExp('<' + name + '\\s[^>]*' + attribute + '="([^"]*)"', 'i').exec(block);
  return m ? decodeEntities(m[1]) : '';
}

/* Returns [{ id, title, author, authorUrl, url, published, updated, category, html, text }]. */
function parseAtom(xml) {
  const entries = [];
  for (const m of String(xml || '').matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)) {
    const block = m[0];
    const authorBlock = tag(block, 'author');
    let html = tag(block, 'content');
    /* Reddit escapes its HTML once inside the XML; phpBB wraps it in CDATA. */
    if (/&lt;/.test(html)) html = decodeEntities(html);
    entries.push({
      id: oneLine(decodeEntities(tag(block, 'id'))),
      title: oneLine(decodeEntities(tag(block, 'title'))),
      author: oneLine(decodeEntities(tag(authorBlock, 'name'))),
      authorUrl: oneLine(tag(authorBlock, 'uri')),
      url: attr(block, 'link', 'href'),
      published: oneLine(tag(block, 'published')) || oneLine(tag(block, 'updated')),
      updated: oneLine(tag(block, 'updated')),
      category: attr(block, 'category', 'label') || attr(block, 'category', 'term'),
      html,
      text: htmlToText(html)
    });
  }
  return entries;
}

module.exports = { parseAtom };
