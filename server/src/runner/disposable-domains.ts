// Curated disposable / temp-mail domain blocklist for the anti-Sybil mint gate.
// Bundled (no network fetch, no external dependency) so the check is deterministic
// and works offline. This covers the major providers and their common alias
// domains; it is a DETERRENT against lazy bulk email creation, not a complete
// census (new disposable domains appear daily). Extend freely: additions are
// safe, removals should be double-checked against real users.

const DOMAINS = [
  // Mailinator family
  "mailinator.com", "mailinator.net", "mailinator.org", "mailinator2.com",
  "sogetthis.com", "mailin8r.com", "mailinater.com", "reallymymail.com",
  "spamherelots.com", "thisisnotmyrealemail.com", "tradermail.info",
  "veryrealemail.com", "binkmail.com", "bobmail.info", "chammy.info",
  "devnullmail.com", "letthemeatspam.com", "mailinator.us", "notmailinator.com",
  "safetymail.info", "spamhereplease.com", "streetwisemail.com", "suremail.info",
  // Guerrilla Mail
  "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "guerrillamail.biz",
  "guerrillamail.de", "guerrillamail.info", "guerrillamailblock.com", "grr.la",
  "sharklasers.com", "pokemail.net", "spam4.me",
  // 10 Minute Mail / timed inboxes
  "10minutemail.com", "10minutemail.net", "10minutemail.co.za", "10minemail.com",
  "10mail.org", "20minutemail.com", "30minutemail.com", "60minutemail.com",
  "givmail.com", "tenminutemail.com", "10minutemail.de", "10minutenmail.xyz",
  "20mail.it", "20email.eu", "hour-email.com", "onehourmail.com",
  // Temp-Mail family
  "temp-mail.org", "temp-mail.io", "temp-mail.ru", "tempmail.com", "tempmail.net",
  "tempmail.dev", "tempmailo.com", "tempmailer.com", "tempmailer.de",
  "tempinbox.com", "tempmailaddress.com", "temporarymail.com", "temporary-mail.net",
  "tempemail.co", "tempemail.net", "tempmail.plus", "tmpmail.org", "tmpmail.net",
  "tmpeml.info", "tmpbox.net", "tmail.ws", "tempr.email", "discard.email",
  "discardmail.com", "discardmail.de", "spambog.com", "spambog.de", "spambog.ru",
  // YOPmail family
  "yopmail.com", "yopmail.fr", "yopmail.net", "cool.fr.nf", "jetable.fr.nf",
  "courriel.fr.nf", "moncourrier.fr.nf", "monemail.fr.nf", "monmail.fr.nf",
  "hide.biz.st", "mymail.infos.st",
  // Dispostable / getnada / inboxes
  "dispostable.com", "getnada.com", "nada.email", "getairmail.com", "inboxbear.com",
  "spamobox.com", "vomoto.com", "abyssmail.com", "boximail.com", "clrmail.com",
  "dbunker.com", "divismail.ru", "esiix.com", "instaddr.ch", "instaddr.win",
  // Mohmal / anonbox / others
  "mohmal.com", "mohmal.im", "mohmal.in", "anonbox.net", "anonymbox.com",
  "trash-mail.com", "trash-mail.de", "trash-mail.at", "trashmail.com",
  "trashmail.de", "trashmail.net", "trashmail.org", "trashmail.io", "trashmail.me",
  "trashmail.ws", "kurzepost.de", "objectmail.com", "proxymail.eu", "rcpt.at",
  "wegwerfmail.de", "wegwerfmail.net", "wegwerfmail.org", "wegwerf-email.de",
  "wegwerfadresse.de", "wegwerfemail.com", "wegwerfemail.de", "einrot.com",
  "fleckens.hu", "gustr.com", "jourrapide.com", "rhyta.com", "superrito.com",
  "teleworm.us", "armyspy.com", "cuvox.de", "dayrep.com",
  // Fakeinbox / spam collectors
  "fakeinbox.com", "fakeinbox.net", "fakemailgenerator.com", "fakemail.fr",
  "spamgourmet.com", "spamgourmet.net", "spamgourmet.org", "spam.la", "spamex.com",
  "spamfree24.com", "spamfree24.de", "spamfree24.org", "spaml.com", "spaml.de",
  "spamspot.com", "spamthis.co.uk", "spamthisplease.com", "speed.1s.fr",
  "supergreatmail.com", "superstachel.de", "teewars.org", "tempemail.com",
  // Maildrop / mailnesia / mailcatch
  "maildrop.cc", "mailnesia.com", "mailcatch.com", "mailexpire.com",
  "mailforspam.com", "mailfreeonline.com", "mailimate.com", "mailme.lv",
  "mailmetrash.com", "mailmoat.com", "mailnull.com", "mailshell.com",
  "mailsiphon.com", "mailslite.com", "mailzilla.com", "mailzilla.org",
  "mintemail.com", "mt2009.com", "mt2014.com", "mt2015.com", "mytrashmail.com",
  // Nospam / no-spam variants
  "no-spam.ws", "nospam.ze.tc", "nospam4.us", "nospamfor.us", "nospamthanks.info",
  "notsharingmy.info", "nowmymail.com", "objectmail.com", "obobbo.com",
  "odnorazovoe.ru", "oneoffemail.com", "onewaymail.com", "online.ms",
  "oopi.org", "ordinaryamerican.net", "otherinbox.com", "ourklips.com",
  "outlawspam.com", "ovpn.to", "owlpic.com", "pancakemail.com",
  // Mailsac / mail-tester style
  "mailsac.com", "mailslurp.com", "mailtothis.com", "mailtrap.io",
  "harakirimail.com", "haltospam.com", "hatespam.org", "hidemail.de",
  "hochsitze.com", "hotpop.com", "hulapla.de", "ieatspam.eu", "ieatspam.info",
  "ihateyoualot.info", "iheartspam.org", "imails.info", "inboxalias.com",
  "inboxclean.com", "inboxclean.org", "incognitomail.com", "incognitomail.net",
  "incognitomail.org", "insorg-mail.info", "ipoo.org", "irish2me.com",
  "iwi.net", "jetable.com", "jetable.net", "jetable.org", "jnxjn.com",
  "junk1e.com", "kasmail.com", "kaspop.com", "killmail.com", "killmail.net",
  "klassmaster.com", "klzlk.com", "kulturbetrieb.info",
  // Moakt / tempail / emailondeck
  "moakt.com", "moakt.cc", "moakt.co", "moakt.ws", "tmails.net", "tmailinator.com",
  "emailondeck.com", "emailfake.com", "email-fake.com", "emailtemporanea.com",
  "emailtemporanea.net", "emailtemporar.ro", "emailtemporario.com.br",
  "emailwarden.com", "emailx.at.hm", "emailxfer.com", "emeil.in", "emeil.ir",
  "emz.net", "enterto.com", "ephemail.net", "etranquil.com", "etranquil.net",
  // Crazymailing / dropmail / smailpro
  "crazymailing.com", "dropmail.me", "10mail.com", "emltmp.com", "yomail.info",
  "smailpro.com", "sute.jp", "spymail.com", "spymail.one",
  // Burner / privaterelay-ish public burners
  "burnermail.io", "burpcollaborator.net", "mailpoof.com", "mailbox52.ga",
  "throwam.com", "throwawayemailaddress.com", "throwawaymail.com", "throam.com",
  "trbvm.com", "trialmail.de", "trickmail.net", "tryalert.com",
  // 33mail / anonaddy-style public catchalls commonly abused
  "33mail.com", "spamdecoy.net", "spam.su", "spamavert.com", "spambob.com",
  "spambob.net", "spambob.org", "spambox.info", "spambox.us", "spamcannon.com",
  "spamcannon.net", "spamcero.com", "spamcon.org", "spamcorptastic.com",
  "spamcowboy.com", "spamcowboy.net", "spamcowboy.org", "spamday.com",
  // Misc very common
  "mailbox.in.ua", "mail-temporaire.fr", "mail-temp.com", "mail1a.de",
  "mail21.cc", "mail2rss.org", "mail333.com", "mail4trash.com", "mailbidon.com",
  "mailblocks.com", "mailbucket.org", "mailcat.biz", "maileater.com",
  "mailed.ro", "maileimer.de", "mailfa.tk", "mailguard.me", "mailhazard.com",
  "mailhazard.us", "mailhz.me", "mailinblack.com", "mailincubator.com",
  "mailismagic.com", "mailjunk.cf", "mailjunk.ga", "mailjunk.gq", "mailjunk.ml",
  "mailjunk.tk", "mailmate.com", "mailorg.org", "mailpick.biz", "mailrock.biz",
  "mailscrap.com", "mailseal.de", "mailtemp.info", "mailtome.de", "mailtrash.net",
  "mailtv.net", "mailtv.tv", "mailzi.ru", "mega.zik.dj", "meinspamschutz.de",
  "meltmail.com", "messagebeamer.de", "mezimages.net", "mierdamail.com",
  "migmail.pl", "ministry-of-silly-walks.de", "mjukglass.nu", "mobi.web.id",
  "mobileninja.co.uk", "moburl.com", "monemail.com", "monumentmail.com",
  "msa.minsmail.com", "mx0.wwwnew.eu", "mycleaninbox.net", "mypartyclip.de",
  "myphantomemail.com", "myspaceinc.com", "myspaceinc.net", "myspacepimpedup.com",
  "myspamless.com", "mytempemail.com", "mytempmail.com", "neomailbox.com",
  "nepwk.com", "nervmich.net", "nervtmich.net", "netmails.com", "netmails.net",
  "netzidiot.de", "neverbox.com", "nice-4u.com", "nincsmail.hu", "nnh.com",
  "noblepioneer.com", "nomail.pw", "nomail.xl.cx", "nomail2me.com",
  "nomorespamemails.com", "nospammail.net", "nowhere.org", "nurfuerspam.de",
  "nus.edu.sg.spam.la", "nwldx.com",
  // Common .xyz/.top/.site burner TLD providers
  "cross-law.xyz", "dishcatfish.top", "kzccv.com", "qiott.com", "wuzup.net",
  "vjuum.com", "laafd.com", "rfgym.com", "diide.com", "vevs.email",
  "zik.dj", "aji.kr", "priest.com", "veo.kr",
  // 1secmail family
  "1secmail.com", "1secmail.org", "1secmail.net", "wwjmp.com", "esiix.com",
  "xojxe.com", "yoggm.com",
  // mail.tm / mail.gw family
  "mail.tm", "mail.gw", "somoj.com", "bugfoo.com", "internetkeno.com",
  // generator.email network (rotating; representative anchors)
  "generator.email", "spam4.me", "dcctb.com", "cuoly.com", "flymail.tk",
  // Others frequently seen in abuse logs
  "deadaddress.com", "deagot.com", "despam.it", "despammed.com", "dfgh.net",
  "digitalsanctuary.com", "dingbone.com", "disposableaddress.com",
  "disposableemailaddresses.com", "disposableinbox.com", "dispose.it",
  "disposeamail.com", "disposemail.com", "dodgeit.com", "dodgit.com",
  "dodgit.org", "donemail.ru", "dontreg.com", "dontsendmespam.de",
  "drdrb.com", "drdrb.net", "dump-email.info", "dumpandjunk.com",
  "dumpmail.de", "dumpyemail.com", "e4ward.com", "easytrashmail.com",
  "einmalmail.de", "email60.com", "emaildienst.de", "emailgo.de",
  "emailias.com", "emailigo.de", "emailinfive.com", "emaillime.com",
  "emailmiser.com", "emailsensei.com", "emailtemporario.com",
  "emailthe.net", "emailtmp.com", "emailto.de", "emailure.net",
  "eyepaste.com", "fansworldwide.de", "fantasymail.de", "fightallspam.com",
  "filzmail.com", "fivemail.de", "fizmail.com", "frapmail.com",
  "friendlymail.co.uk", "front14.org", "fuckingduh.com", "fudgerub.com",
  "fux0ringduh.com", "garliclife.com", "gehensiemirnichtaufdensack.de",
  "get1mail.com", "get2mail.fr", "getonemail.com", "getonemail.net",
  "ghosttexter.de", "girlsundertheinfluence.com", "gishpuppy.com",
  "gowikibooks.com", "gowikicampus.com", "gowikicars.com", "gowikifilms.com",
  "gowikigames.com", "gowikimusic.com", "gowikinetwork.com", "gowikitravel.com",
  "gowikitv.com", "great-host.in", "greensloth.com", "gsrv.co.uk",
  "hacccc.com", "haddo.eu", "hidzz.com", "hmamail.com", "hopemail.biz",
  "ano-mail.net", "anonymail.dk", "anonymized.org", "antichef.com",
  "antichef.net", "antireg.ru", "antispam.de", "antispammail.de",
  "azmeil.tk", "baxomale.ht.cx", "beefmilk.com", "bigstring.com",
  "bio-muesli.net", "bootybay.de", "boun.cr", "bouncr.com", "breakthru.com",
  "brefmail.com", "broadbandninja.com", "bsnow.net", "bspamfree.org",
  "bugmenot.com", "bumpymail.com", "bund.us", "buymoreplays.com",
  "byom.de", "c2.hu", "card.zp.ua", "casualdx.com", "cek.pm",
  "centermail.com", "centermail.net", "chogmail.com", "choicemail1.com",
  "clixser.com", "cmail.net", "cmail.org", "coldemail.info", "consumerriot.com",
  "cool.fr.nf", "correo.blogos.net", "cosmorph.com", "courriel.fr.nf",
  "courrieltemporaire.com", "crapmail.org", "cust.in", "cubiclink.com",
  "curryworld.de", "cuvox.de", "dandikmail.com", "dayrep.com",
] as const;

const DISPOSABLE = new Set<string>(DOMAINS);

/** True when the email's domain is a known disposable / temp-mail provider. */
export function isDisposableDomain(domain: string): boolean {
  const d = domain.toLowerCase().trim();
  if (DISPOSABLE.has(d)) return true;
  // Subdomain trick (foo.mailinator.com) still lands in the provider's inbox.
  const parts = d.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    if (DISPOSABLE.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

/** Exposed for tests / forensics tooling. */
export const DISPOSABLE_DOMAIN_COUNT = DISPOSABLE.size;
