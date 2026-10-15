-- Scene language gains 'hinglish' (Hindi voice, captions in Roman letters).
ALTER TABLE "Scene" DROP CONSTRAINT "Scene_language_check";
ALTER TABLE "Scene" ADD CONSTRAINT "Scene_language_check" CHECK ("language" IN ('hi', 'hinglish', 'en'));
