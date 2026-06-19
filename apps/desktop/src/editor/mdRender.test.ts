// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { mdRender } from './mdRender';

describe('mdRender', () => {
  it('renders Markdown to HTML', () => {
    expect(mdRender('# Title')).toContain('<h1>Title</h1>');
    expect(mdRender('**bold**')).toContain('<strong>bold</strong>');
  });

  it('rewrites wikilinks to data-wikilink anchors', () => {
    const h = mdRender('see [[Note A]] and [[b/c|Alias]]');
    expect(h).toContain('data-wikilink="Note A"');
    expect(h).toContain('>Note A<');
    expect(h).toContain('data-wikilink="b/c"');
    expect(h).toContain('>Alias<');
  });

  it('strips dangerous markup (XSS)', () => {
    expect(mdRender('<script>alert(1)</script>')).not.toContain('<script>');
    expect(mdRender('<img src=x onerror="alert(1)">')).not.toContain('onerror');
  });
});
