import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'unescapeNewlines',
  standalone: true,
})
export class UnescapeNewlinesPipe implements PipeTransform {
  transform(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    // Convert double-escaped CRLF/CR/LF sequences ("\r\n", "\n", "\r") to real newlines
    // Also collapse triple-escaped patterns like "\\n" → "\n"
    return value
      .replace(/\\r\\n/g, '\n') // "\r\n" → newline
      .replace(/\\n/g, '\n')      // "\n" → newline
      .replace(/\\r/g, '\n');     // "\r" → newline
  }
}
