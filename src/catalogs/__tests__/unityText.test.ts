import { expect, it } from 'vitest';
import { extractXmlTextAssets } from '../unityText.ts';
import { serializedFile } from '../../testing/unityAssets.ts';

it.each(['Objects', 'GroundTypes'])('extracts %s with BOM, attributes and whitespace', root => {
  for (const bom of ['', '\uFEFF']) {
    for (const suffix of ['>', ' foo="1">', '\nfoo="1">', ' >']) {
      const xml = `<?xml version="1.0"?><${root}${suffix}</${root}>`;
      expect(extractXmlTextAssets(serializedFile([{ classId: 49, text: bom + xml }]))).toEqual({
        objects: root === 'Objects' ? [xml] : [],
        tiles: root === 'GroundTypes' ? [xml] : [],
      });
    }
  }
});

it('ignores similarly named roots and non-TextAssets', () => {
  expect(extractXmlTextAssets(serializedFile([
    { classId: 49, text: '<?xml?><ObjectsExtra></ObjectsExtra>' },
    { classId: 49, text: '<?xml?><GroundTypesExtra></GroundTypesExtra>' },
    { classId: 28, text: '<?xml?><Objects></Objects>' },
  ]))).toEqual({ objects: [], tiles: [] });
});
