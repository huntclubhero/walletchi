-- ERC-8426 rotation: the Google Wallet object a pet's links live in. Every account that saved a
-- Google object shares it, so rotating the links (a new owner's claim, or the owner's "reset my
-- pass links") must move them to a NEW object and expire the old one; patching the old object
-- would deliver the fresh links to every copy a leak produced, and to the previous owner after a
-- sale. Null means the legacy object id (runner_<serial>), so existing saved cards keep updating
-- until their first rotation. Additive, nullable: existing rows are untouched.
ALTER TABLE "Runner" ADD COLUMN "googleObjectId" TEXT;
