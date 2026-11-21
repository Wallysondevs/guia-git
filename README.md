# Guia Git

Site: https://wallysondevs.github.io/guia-git/

Curso de Git e GitHub em português, do zero ao avançado, feito para quem **nunca usou Git** (e mal usou o terminal). Funciona como uma escola: uma aula para cada comando ou ideia, organizadas em **3 níveis + projetos + referência** (115 páginas). Vai de `commit`, `status` e `diff` até branches, merge, conflitos, remotos, `push`, `pull`, pull request e rebase.

Cada aula explica cada parte do comando (anatomia: `git`, o subcomando, as opções, os argumentos), mostra a **saída real** do Git e explica linha por linha o que ela diz, mostra o estado antes e depois (a pasta, a área de preparo, o histórico) e o que acontece quando dá errado, com a mensagem verdadeira e o jeito de sair da situação. As saídas foram conferidas no **Git 2.53** do Ubuntu 26.04, em pt_BR. Os comandos modernos (`git switch`, `git restore`) vêm primeiro, e a branch padrão é `main`.

Para praticar, as páginas trazem o **terminal simulado** (`.try`): a máquina fictícia da Ana, com missões que conferem se você chegou ao resultado (por exemplo, fazer o primeiro commit ou resolver um conflito). As missões com remotos usam um "GitHub" de mentira dentro do próprio simulador.

O terminal é o Bash simulado do Guia Bash (`assets/bashsim.js`) com **um Git imitado em JavaScript** (`assets/gitsim.js`). O repositório existe de verdade no sistema de arquivos fictício, dentro de `.git`, com blobs, árvores e commits com o **SHA-1 real**: os hashes saem iguais aos do Git de verdade. O simulador é comparado automaticamente com o Git real (veja **Testes**).

Site 100% estático (HTML + CSS + JS, sem build e sem dependências externas): abre direto no navegador e funciona no GitHub Pages.

## Estrutura

```
index.html                 página inicial
<tema>.html                uma aula por tema
assets/style.css           visual
assets/site.js             níveis/menu (lista NIVEIS), Anterior/Próximo, terminais, anatomia, exercícios
assets/bashsim.js          o Bash simulado + interface do terminal
assets/bashsim-ajuda.js    textos do `help` (carregados sob demanda)
assets/gitsim.js           o Git simulado
assets/gitsim-ajuda.js     textos do `git COMANDO -h`
tools/sim.js               mostra uma sessão do simulador no formato das aulas
tools/testar-missoes.js    testa todas as missões (e compara com o Git real do laboratório)
tools/testes/              bateria diferencial simulador × Bash e Git reais
tools/demo.html            página de teste da interface do simulador
CONTRIBUINDO.md            como escrever uma aula
.nojekyll                  faz o GitHub Pages servir os arquivos como estão
```

## Testes

```bash
node tools/testar-missoes.js                 # todas as missões
node tools/testar-missoes.js pagina.html     # só estas páginas
node tools/testar-missoes.js --nativo pagina.html   # compara também com o Git real (precisa do laboratório)
node tools/testes/rodar.js git               # bateria diferencial do Git (precisa do laboratório)
node tools/sim.js 'git init' 'git status'    # mostra uma sessão do simulador
```

## Publicar no GitHub Pages

Envie a pasta para um repositório e ative **Settings → Pages → Deploy from a branch → main / (root)**.

## Adicionar uma aula

Leia `CONTRIBUINDO.md` e inclua a página na lista `NIVEIS` de `assets/site.js`.
