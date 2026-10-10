# Agent to Discord

Ovládej svého Codex agenta přes Discord. Malý samostatný most v Node.js: zpráva založí Discord vlákno, které si pamatuje svou Codex konverzaci i po restartu.

Inspirováno projektem [Agent2Telegram](https://github.com/petrludwig-collab/Agent2Telegram). Jde o samostatnou implementaci pro Discord využívající [Codex app-server](https://developers.openai.com/codex/app-server/), bez tmux a bez parsování obrazovky terminálu.

## Co umí

- Nové zadání v určeném kanálu → nové Discord vlákno a Codex konverzace.
- Další zprávy ve vlákně pokračují ve stejné konverzaci.
- Zprávy agenta a konečný stav, dlouhé odpovědi rozdělené podle limitu Discordu.
- Schválení nebo odmítnutí konkrétního příkazu/změny souborů přes tlačítka; úplné podrobnosti v JSON příloze. Po 10 minutách bez odpovědi se požadavek odmítne.
- Odpovědi na strukturované otázky přes `!answer` podle zaslané šablony.
- Příchozí soubory a obrázky, nejvýše 5 příloh po 8 MiB; uložení pod `discord-uploads/` v pracovním adresáři.
- Výslovné stažení výsledného souboru příkazem `!file cesta`.
- Jeden povolený uživatel, server a kanál. Automatické zmínky uživatelů/rolí jsou vypnuté.
- Trvalé mapování konverzací, ochrana proti opakovanému zpracování zpráv a diagnostika připojení.

Verze 0.1 je určena pro osobního agenta. Hlas, více uživatelů, plánování úkolů a připojení k libovolnému existujícímu terminálu nejsou implementované. Během běžícího úkolu bot další zadání odmítne; neudržuje frontu. Obecné žádosti o rozšíření oprávnění a MCP formuláře nepovoluje. Pokud nelze zobrazit příkaz nebo změny souborů, tlačítko schválení zůstane vypnuté.

## Požadavky

- Node.js 22.12+ a `ps` (na Debianu balíček `procps`).
- Nainstalovaný a přihlášený Codex CLI. Integrace ověřována s verzí **0.162.1**; rozhraní app-server se může mezi verzemi měnit.
- Discord bot s povoleným **Message Content Intent** v Developer Portal → Bot.
- Bot přidaný na server s oprávněními **View Channel, Send Messages, Create Public Threads, Send Messages in Threads, Read Message History, Attach Files** v určeném textovém kanálu. Administrator není potřeba.
- Odchozí HTTPS/WebSocket připojení ke službám Discord a OpenAI. Žádný příchozí port nebo veřejný webhook.

## Instalace

Balíček lze nainstalovat přímo z GitHubu, bez publikace do npm registru:

```sh
npm install --global git+https://github.com/mezerap/agent-to-discord.git#v0.1.0
agent-to-discord setup
agent-to-discord doctor
agent-to-discord start
```

`start` běží v popředí; pro nepřetržitý provoz jej spouští Docker nebo správce služeb. Pokud nemáš právo zapisovat do globálního npm adresáře, použij vlastní prefix — postup pro Docker níže.

Alternativně lze stáhnout zdrojový projekt:

```sh
git clone https://github.com/mezerap/agent-to-discord.git
cd agent-to-discord
npm ci --ignore-scripts
node src/cli.js setup
```

Průvodce se zeptá na kanál, uživatele, pracovní adresář a token bota. Při zadávání tokenu se znaky nezobrazují. Ověří přístup ke kanálu, zjistí server a vytvoří `$CODEX_HOME/agent-to-discord/.env` s privátními právy; bez `CODEX_HOME` použije `~/.codex/agent-to-discord/.env`. Nepřepíše existující soubor. Token neposílej do chatu a nevkládej do příkazové historie. Discord ID najdeš přes Developer Mode → Copy ID.

```sh
node src/cli.js doctor
node src/cli.js start
```

`doctor` ověří přihlášení Codexu, spojení Discordu a oprávnění kanálu. Neposílá zprávy. Skutečné přijímání textových zpráv ověří až zpráva uživatele do kanálu. Pro globální příkaz lze ve staženém projektu použít `npm install -g .`, potom `agent-to-discord start --env-file /cesta/.env`.

Konfigurace v `.env.example`:

| Proměnná | Význam |
| --- | --- |
| `DISCORD_TOKEN` | Tajný bot token |
| `DISCORD_GUILD_ID` | Povolený Discord server |
| `DISCORD_CHANNEL_ID` | Nadřazený textový kanál |
| `DISCORD_USER_ID` | Jediný uživatel, který smí agenta ovládat |
| `AGENT_WORKSPACE` | Pracovní adresář; výchozí aktuální adresář |
| `AGENT_STATE_DIR` | Trvalý stav mostu; výchozí `$CODEX_HOME/agent-to-discord` |
| `CODEX_BIN` | Volitelná cesta k CLI, výchozí `codex` |
| `CODEX_MODEL` | Volitelný model; jinak nastavení Codexu |

## Použití

Napiš do povoleného kanálu například „Vytvoř jednoduchou HTML stránku“. Bot založí vlákno. Další zadání piš do něj; nová zpráva v nadřazeném kanálu založí novou konverzaci.

| Příkaz | Chování |
| --- | --- |
| `!help` | Nápověda |
| `!status` | Skutečný stav posledního úkolu z Codexu, případně poslední odpověď |
| `!stop` | Požadavek na přerušení běžícího úkolu |
| `!file web/index.html` | Pošle konkrétní soubor z workspace do Discordu |
| `!answer {"id_otazky":"odpověď"}` | Odpověď na čekající otázky; použij zaslanou šablonu |

Po restartu se rozpracované zadání **nespustí znovu**. Použij `!status` pro zjištění stavu; podle něj můžeš zadat další práci. Zprávy poslané během úplného vypnutí bota se zpětně nenačítají. Pokud Discord nedoručí odpověď, `!status` ji načte z historie Codexu. Přesně jednou doručené síťové operace nelze garantovat; bot při nejasném výsledku žádný úkol automaticky neopakuje.

## Docker a trvalá data

Ve svém existujícím kontejneru můžeš pod uživatelem `node` instalovat balíček do volume:

```sh
npm install --global --prefix /home/node/.codex git+https://github.com/mezerap/agent-to-discord.git#v0.1.0
/home/node/.codex/bin/agent-to-discord setup
/home/node/.codex/bin/agent-to-discord doctor
/home/node/.codex/bin/agent-to-discord start
```

Instalace i konfigurace tak přežijí znovuvytvoření kontejneru, pokud zachováš volume `/home/node/.codex`. Pro automatický start této instalace nahraď ve svém Compose `sleep infinity`:

```yaml
command: ["/home/node/.codex/bin/agent-to-discord", "start"]
```

Tuto změnu proveď až po instalaci a úspěšném `doctor`. Před nasazením Compose ukonči ručně spuštěného bota. `restart: unless-stopped` zajistí opětovné spuštění po pádu/restartu; samotné spuštění přes `docker exec` tuto vlastnost nemá. Při změně hlavní verze Node nebo architektury balíček znovu nainstaluj.

Bot běží ve stejném kontejneru jako Codex pod běžným uživatelem `node`. Spouští vlastní `codex app-server --stdio`, používá stejné `CODEX_HOME` a přihlášení. Nemění ani neaktualizuje samostatný CLI daemon. Každé Discord vlákno má vlastní novou Codex konverzaci; nesdílí právě otevřenou interaktivní relaci.

Alternativou k instalaci do volume je zabudování balíčku do image: přidej zdrojový projekt, spusť `npm ci --omit=dev --ignore-scripts` a jako hlavní příkaz kontejneru nastav například:

```yaml
command:
  - node
  - /opt/agent-to-discord/src/cli.js
  - start
  - --env-file
  - /home/node/.codex/agent-to-discord/.env
```

Zachovej své existující named volumes pro `/workspace` a `/home/node/.codex`. Konfiguraci a stav bota dej do druhého volume, zdrojový kód zabuduj do image mimo workspace. Doporučené nastavení zůstává `user: node`, `init: true`, `restart: unless-stopped`, bez Docker socketu a bez privileged. Instalace tohoto projektu sama nemění capabilities, AppArmor ani seccomp; host musí podporovat sandbox Codexu.

Po pádu mostu ukončí proces kontejner; Docker ho znovu spustí podle restart policy. Zálohuj obě volumes. Volume chrání proti znovuvytvoření kontejneru, nikoli proti ztrátě disku nebo smazání dat.

## Oprávnění a soukromí

Codex používá `workspace-write` a schvalování `on-request`, s uživatelem jako schvalovatelem. Bot automaticky nezapíná plný přístup ani schvalování bez dotazu. Jednorázové schválení příkazu může umožnit akci mimo vnitřní sandbox; stále platí práva uživatele a omezení Dockeru. Tlačítko je vázané na konkrétní účet, Discord vlákno a aktivní úkol.

Token se nepředává v prostředí potomka Codexu. To však není úplné oddělení tajných údajů: procesy pod stejným unixovým uživatelem mohou podle systému číst navzájem soubory či prostředí. Workspace, konfigurace a agent nejsou oddělené bezpečnostní kontejnery. Token neukládej do workspace. Bot nepíše obsah úloh do provozních logů; historie zůstává v Codexu a Discordu.

Text konverzace a ručně vyžádané soubory se přenášejí do Discordu. Skryté soubory, běžné autentizační soubory a cesty mimo workspace nelze přes `!file` exportovat; tato kontrola není klasifikátor všech možných tajných údajů. Soubor vyžaduj jen tehdy, když jeho sdílení zamýšlíš.

## Vývoj

```sh
npm ci --ignore-scripts
npm test
npm audit
```

Testy pokrývají autorizaci, opakované zprávy, restart, soubory, schvalování, chyby úloh a odpojení RPC. Pro integrační ověření je nutný skutečně přihlášený Codex a vlastní Discord bot. CI testy nepoužívají produkční tokeny.

MIT licence. Neoficiální projekt; není produktem OpenAI ani Discordu.
