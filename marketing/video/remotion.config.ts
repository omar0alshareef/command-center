import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setCodec('h264');
Config.setPixelFormat('yuv420p');
// Quality vs size: the target is well under 25 MB for 32 s.
Config.setCrf(20);
Config.setOverwriteOutput(true);
