import { loadFont as loadCairo } from '@remotion/google-fonts/Cairo';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { loadFont as loadLora } from '@remotion/google-fonts/Lora';

// The google-fonts loaders hold the render (delayRender) until each font is ready, so no frame is drawn in a fallback face.
loadLora('normal', { weights: ['500', '600'], subsets: ['latin'] });
loadLora('italic', { weights: ['500', '600'], subsets: ['latin'] });
loadInter('normal', { weights: ['500', '600'], subsets: ['latin'] });
loadCairo('normal', { weights: ['700'], subsets: ['arabic', 'latin'] });
