# Como escrever uma página do Guia Git

O guia é uma **escola**, estilo W3Schools, para quem **nunca usou Git** (e mal usou o terminal). **Uma aula = um assunto** (um comando ou uma ideia). O dono do projeto já reclamou de outro guia que juntava vários assuntos numa página. Nunca mostre um comando "seco":
- explique cada parte (anatomia: `git`, o subcomando, as opções, os argumentos);
- mostre a **saída real** do Git (laboratório, §5) e explique **linha por linha** o que ela diz — o `git status` e as dicas (`(use "git add <arquivo>..." …)`) são o melhor professor do Git;
- mostre **o estado antes e depois** (o que mudou na pasta, na área de preparo, no histórico); desenhe o histórico quando ajudar (o `git log --oneline --graph` real, ou um diagrama simples em `pre` com `A---B---C`);
- mostre o que acontece quando dá errado, com a mensagem **real** do Git, e como sair da situação;
- deixe o leitor praticar no terminal simulado do guia, que tem **um Git** de verdade imitado em JavaScript (§4).

Antes de tudo, leia o `RECURSOS.md`: onde trabalhar (VPS) e como.

## 0. O que o guia ensina
- **Git na linha de comando** (o Git do Ubuntu 26.04 — versão exata no `COMO-USAR.md` do lab), com as mensagens **em português** (o Git do leitor brasileiro sai em português quando o sistema está em pt_BR; diga numa nota que, com o sistema em inglês, as mensagens saem em inglês e mostre a equivalente quando for importante).
- **GitHub** no grupo "GitHub" e em "Trabalhando em Equipe": conta, repositório, SSH/token, Pages, fork, pull request, issues. O site do GitHub **não roda no lab**: descreva com cuidado o que o leitor vê (sem inventar nomes de botões que você não conferiu na documentação oficial docs.github.com/pt) e marque como ilustrativo.
- Comandos modernos primeiro (`git switch`, `git restore`); os antigos (`git checkout`, `git reset HEAD arquivo`) aparecem para o leitor reconhecer em tutoriais antigos.
- Branch padrão: **`main`** (o lab configura `init.defaultBranch=main`; explique numa nota, em `git-init.html`, que sem essa configuração o Git ainda pode criar `master` e mostra uma dica — mostre a dica real).

## 1. Esqueleto do arquivo
Igual ao Guia Bash (veja `~/guia-bash` no notebook, por exemplo `~/guia-bash/variaveis.html`), trocando:
- `<title>Git TEMA — descrição curta | Guia Git</title>`;
- `<h1>Git <span class="hl">TEMA</span></h1>`.

Menu, selo e Anterior/Próximo vêm de `assets/site.js` (`NIVEIS`). **Não mude a `NIVEIS`.** Links internos só para páginas que estão nela.

## 2. Ordem de uma aula
1. **Intro** (`p.intro`).
2. **"Você vai aprender"** (`div.note`, 3–5 itens).
3. **A ideia antes do comando**, com uma comparação do dia a dia (o "salvar como versão_final_2.docx", uma caixa de fotos com etiquetas, um caderno de rascunho × caderno passado a limpo).
4. **Do simples ao completo**, uma novidade por vez, com `dl.anatomy`.
5. **Toda saída explicada**, com anotações `«` nas linhas importantes. Mostre o `git status` depois de cada mudança importante.
6. **Experimente** (`.try`): **pelo menos um por aula** (exceto referência e páginas só de GitHub): uma missão no terminal simulado, com o repositório já preparado pelo `data-setup`.
7. **Formas diferentes** de fazer a mesma coisa + tabela "qual usar".
8. **Quando dá errado** (`div.cenario`): mensagem real → o que aconteceu → como confirmar → como resolver (incluindo os clássicos: `fatal: not a git repository`, `nothing to commit`, `Please tell me who you are`, conflito, push rejeitado, `detached HEAD`…).
9. **Referência** (`table.ref`).
10. **Exercícios** (3 ou mais: `.exercise` e `.mc`).
11. **Resumo**.

Páginas de **Projetos**: uma história passo a passo (a Ana versionando o site de receitas, trabalhando com o Bruno), com várias missões `.try` encadeadas. Páginas de **Referência**: tabelas.

## 3. Componentes

### Sessão de terminal (`pre.term`)
Como no Guia Bash: `$ ` = comando (vira `ana@notebook:~$`, e o prompt acompanha `cd` — use `data-cwd="~/receitas"` para começar numa pasta); `> ` logo depois de um comando = continuação; `«` = anotação; dentro de `<pre>`, `&lt;` `&gt;` `&amp;` (o Git usa muito `<arquivo>`: escreva `&lt;arquivo&gt;`).

Toda saída vem do laboratório (§5). Exemplo:
```html
<pre class="term" data-cwd="~/receitas">$ git status
No ramo main
Nenhum commit ainda
…
</pre>
```

### Arquivo (`pre.file`) e Anatomia (`dl.anatomy`)
Como no Guia Bash.

### Experimente no terminal (`.try`) — com Git
```html
<div class="try" data-setup="mkdir receitas;;cd receitas;;git init -q;;echo '# Receitas' &gt; README.md" data-goal="commits:1,limpo" data-solucao="git add README.md;;git commit -m 'Primeiro commit'">
<p class="try-task"><strong>Missão:</strong> faça o primeiro commit do README.md com a mensagem "Primeiro commit".</p>
</div>
```
- `data-setup`: comandos rodados antes (separados por `;;`), invisíveis para o leitor — use para montar o repositório da missão (commits, branches, um "servidor" remoto). O simulador é rápido: dá para fazer 10 commits no setup.
- `data-goal`: metas separadas por vírgula, **todas** precisam ser verdade (tabela abaixo).
- `data-solucao` (**obrigatório**): os comandos que cumprem a missão (`;;` entre eles).
- A missão **não** pode estar cumprida já pelo setup (o testador confere).
- O nome e o e-mail da Ana já estão configurados no simulador e no lab (`Ana Souza <ana@exemplo.com>`), e a data é fixa (15/10/2026 10:30, −03:00): por isso **os hashes dos commits saem iguais** no simulador e no lab. Mesmo assim, **prefira metas que não dependam de hash**.

### Metas (`data-goal`) — as do Guia Bash e as do Git
Valem todas as metas do Guia Bash (`dir: file: absent: contains: cwd: ran: out: outre: err: exit: …`, veja `~/guia-bash/CONTRIBUINDO.md` §4) **mais** as do Git, que olham o repositório da pasta atual:

| Meta | Verdade quando… |
| --- | --- |
| `repo` | a pasta atual está dentro de um repositório Git |
| `commits:N` | o branch atual tem exatamente N commits (`git rev-list --count HEAD`) |
| `limpo` | não há nada a commitar (`git status --porcelain` vazio) |
| `preparado:CAMINHO` | o arquivo está na área de preparo (staged) com mudanças |
| `naopreparado:CAMINHO` | o arquivo tem mudanças fora da área de preparo |
| `rastreado:CAMINHO` / `ignorado:CAMINHO` | o arquivo é rastreado / é ignorado pelo `.gitignore` |
| `branch:NOME` / `semBranch:NOME` | o branch existe / não existe |
| `head:NOME` | o branch atual é NOME (`head:destacado` = HEAD destacado) |
| `msg:TEXTO` | a mensagem do último commit (HEAD) contém o texto |
| `logre:REGEX` | a saída de `git log --oneline` (do HEAD) casa com a regex |
| `tag:NOME` | a tag existe |
| `remoto:NOME` | o remoto existe |
| `conflito` / `semconflito` | há (não há) um merge/rebase em andamento com conflito |
| `contem:REF=TEXTO` | o arquivo, na versão do commit REF (`HEAD:receita.txt`, `main:README.md`), contém o texto |
| `stash:N` | há N itens no stash |

Use `\,` para uma vírgula dentro de uma meta. O agente do simulador pode acrescentar metas — **a lista oficial e o que cada uma faz exatamente fica na §4**.

### Outros blocos
`div.note/.tip/.warning/.cenario`, `ol.passo`, `div.table-wrap > table.ref`, `.exercise`, `.mc`, `figure`, `<span class="versao">git 2.23+</span>` (para comandos que não existem em Gits antigos: `switch`/`restore` são do 2.23).

## 4. O simulador (`assets/bashsim.js` + o Git simulado)
> **Esta seção é mantida pelo agente do simulador.** Antes de escrever uma frase do tipo "no terminal do guia…", confira com as ferramentas dele (`tools/sim.js`).

(em construção)

## 5. Fidelidade: o laboratório (`~/guia-git-lab/lab`, na VPS)
É a máquina da Ana (usuária `ana`, computador `notebook`, `/home/ana`, pt_BR, Ubuntu 26.04) com **o Git real do Ubuntu**, a data fixa (15/10/2026 10:30, a mesma do simulador) e um "GitHub de mentira" local para `clone`/`push`/`pull` (detalhes no `~/guia-git-lab/COMO-USAR.md`, na VPS):
- toda saída de `pre.term` sai do lab, **nunca de memória**;
- **as mensagens do Git saem em português** (pt_BR): copie como saíram;
- o que é do site do GitHub (botões, telas, pull request na web) é **ilustrativo**: diga isso e baseie-se na documentação oficial (docs.github.com/pt);
- **Privacidade:** nada da máquina real nem da VPS; só `/home/ana/…`, `ana@notebook`, `Ana Souza <ana@exemplo.com>`, usuário `ana-souza` no GitHub (fictício).

## 6. Escrita
- Português do Brasil, frases curtas, "você". O leitor nunca usou Git.
- Termos em inglês ganham tradução na primeira vez: *commit* = "registro/fotografia", *branch* = "ramo", *merge* = "mesclar/juntar", *staging area* = "área de preparo", *push* = "empurrar/enviar".
- Exemplos com a vida da Ana: o site de receitas, o TCC, a lojinha, trabalhando em dupla com o Bruno.
- Boas práticas desde o começo, sempre com o porquê: commits pequenos, mensagens claras no imperativo, `git status` sempre, nunca `--force` sem `--with-lease`, nunca commitar senhas.
