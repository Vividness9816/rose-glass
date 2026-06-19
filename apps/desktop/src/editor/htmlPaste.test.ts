import { describe, it, expect } from 'vitest';
import { htmlToMarkdown } from './htmlPaste';

describe('htmlToMarkdown', () => {
  it('converts headings and bold to Markdown', () => {
    expect(htmlToMarkdown('<h1>Title</h1>')).toBe('# Title');
    expect(htmlToMarkdown('<strong>bold</strong>')).toBe('**bold**');
  });

  it('converts links', () => {
    expect(htmlToMarkdown('<a href="https://x.com">x</a>')).toBe('[x](https://x.com)');
  });

  it('uses fenced code blocks', () => {
    expect(htmlToMarkdown('<pre><code>a()</code></pre>')).toContain('```');
  });
});
