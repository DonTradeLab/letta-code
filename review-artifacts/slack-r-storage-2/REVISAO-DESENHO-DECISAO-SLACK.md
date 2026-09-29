# Revisão do contrato de decisão Slack — R-storage-1

O parecer anterior está em `desenho-contrato-decisao/REVISAO-DESENHO-DECISAO-SLACK-R1.md`.

## Veredito único: FAIL

Ainda não está pronto para construir. A primitiva única no `LocalStore`, sem diário paralelo, está no rumo certo. Duas escolhas desta revisão quebram a demanda original: autorização que funciona e retomada sem gambiarra. Evitar efeito indevido não basta.

Nada foi aplicado. N13 continua no FAIL. Restart do 4500, Telegram e TUI continuam fechados.

## O que a fonte confirma

HEAD limpo dos módulos de aprovação e store: `1ff4d95eff41633e4fcf37a29a0587216666fe88`. `createRuntime` grava `sessionId` como `listen-${UUID}` na subida do processo (`lifecycle.ts:251`). Isso não é a conexão Slack nem o caller. Reconectar o gateway no mesmo processo não cria outro dono.

`withFileLock` com `reapOnlyDeadOwner` não rouba holder vivo: só remove se o PID não é o mesmo processo, e o release compara o payload. Não elimina corrida de PID reutilizado se `started` não entrar na comparação, nem torna o helper async equivalente a um lock síncrono. A sonda de oito observações mostra o writer quente ignorando o lock e apagando linha já fsynced. Isso prova que writer antigo fora do lock não é seguro. Não prova que, com todos os writers no mesmo lock, append e rewrite sejam a mesma coisa.

O sink normal ainda é `appendFileSync` (`local-store.ts:3042`). Rewrite do arquivo inteiro é o caminho fully resident, não o de cada chunk.

## 1. Dono e reconexão

`OPEN.owner` no desenho exige a sessão do listener que abriu. Outro processo que só ganhou o lock não ganha o turno. Isso está certo para dois listeners vivos.

Não está certo tratar toda reconexão como OPEN alheio. Gateway novo, mesma sessão `listen-…`, resolver ainda na memória: a decisão continua atendível. Não exige janela quiescente. Conexão não é dono do turno.

Processo morto é outro caso. O desenho manda manutenção quiescente para retirar o OPEN e não executar a chamada. Isso deixa AskUserQuestion e aprovação já aberta sem retomada até alguém parar todos os writers. A demanda pede retomada. O mínimo: se o PID gravado está morto, o mesmo hardlink lock, com `started` conferido, adota o OPEN numa linha, mesma geração, sem decisão nova. Resolver vivo da sessão antiga, se ainda existir, continua o único executor. Não há takeover automático de dono vivo.

## 2. Custo do rewrite

Reescrever o transcript completo, com fsync do arquivo e do diretório, em todo append, inclusive chunk de stream, não está sustentado. A sonda refuta append concorrente com um `updateConversation` que não participa do lock. Participando todos, append mais fsync sob o mesmo lock conserva a linha nova e não relê a conversa inteira. Rewrite atômico continua necessário em compaction, upgrade e persistência fully resident, e nesse caminho relê e preserva `letta_control`. Dois formatos físicos, uma autoridade, um lock. Não é segundo diário. “Medir depois” não autoriza construir o caminho caro: o append já existe e é o de menor custo total.

## 3. Recibo e retomada

Recibo recuperado não deve repetir efeito externo incerto. Isso permanece. Não deve, por isso, recusar a primeira execução. Se a decisão está gravada e não há marcador de efeito iniciado, a continuação nativa — AskUserQuestion ou aprovação — pode receber um permit, uma vez, na sessão que adotou o OPEN. Crash depois que a ferramenta pode ter começado: não repetir. Isso não é exactly-once externo. É a diferença entre sistema utilizável e sistema inerte.

Lock órfão de processo morto usa o reap já existente, com identidade do processo, não uma janela em que todo writer para. Lock de holder vivo continua intocável. Manutenção quiescente fica para delete, migração e writer antigo, como o desenho já exige antes de aplicar. Essa janela não está autorizada agora.

## Menor ajuste

Construir só depois de trocar estas três frases no desenho: adoção de OPEN de PID morto sem decisão nova; append+fsync no caminho normal e rewrite só onde o store já reescreve; permit único se não houve efeito, bloqueio só se o efeito é incerto. O resto de 2.A — uma primitiva, reread sob lock, primeira decisão ganha, schema 3, capability negociada — pode permanecer. Base isolada 0.33.6, sem misturar com a worktree de fallback nem com a candidata Slack.
