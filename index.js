const got = require('got');
const {MongoClient} = require('mongodb');
const nodemailer = require('nodemailer');
const markdown = require('nodemailer-markdown').markdown;

async function retrieve() {
  const response = await got.post('https://api.github.com/graphql', {
    headers: {
      Authorization: `bearer ${process.env.GITHUB_ACCESS_TOKEN}`
    },
    body: {
      query: `
        {
          search(type: REPOSITORY, query: "org:${process.env.ORGANISATION}", first: 100) {
            repositoryCount
            edges {
              node {
                ... on Repository {
                  name
                  description
                  url
                  forkCount
                  stargazers {
                    totalCount
                  }
                  defaultBranchRef {
                    target {
                      ... on Commit {
                        history {
                          totalCount
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      `
    },
    json: true
  });
  return response.body.data.search.edges.map(({node}) => {
    const {
      name,
      description,
      url,
      forkCount: forks,
      stargazers: {totalCount: stars}
    } = node;
    const commits = (node.defaultBranchRef && node.defaultBranchRef.target.history.totalCount) || 0;
    return {name, description, url, forks, stars, commits};
  });
}

async function store(rs) {
  const client = await new MongoClient(process.env.MONGO_URL).connect();
  for (const r of rs) {
    const {value} = await client
      .db()
      .collection('repositories')
      .findOneAndUpdate({name: r.name}, r, {upsert: true});
    Object.assign(r, {
      deltaForks: r.forks - ((value && value.forks) || 0),
      deltaStars: r.stars - ((value && value.stars) || 0),
      deltaCommits: r.commits - ((value && value.commits) || 0)
    });
  }
  await client.close();
  return {
    forks: Math.max(...rs.map(r => r.deltaForks)),
    stars: Math.max(...rs.map(r => r.deltaStars)),
    commits: Math.max(...rs.map(r => r.deltaCommits))
  };
}

module.exports = async function(context) {
  const rs = await retrieve();
  const maxDeltas = await store(rs);
  let message = '';
  if (maxDeltas.forks) {
    message +=
      `Most forked (+${maxDeltas.forks}):\n\n` +
      rs
        .filter(r => r.deltaForks === maxDeltas.forks)
        .map(r => `- [${r.name}](${r.url}) (${r.forks})`)
        .join('\n') +
      '\n\n';
  }
  if (maxDeltas.stars) {
    message +=
      `Most starred (+${maxDeltas.stars}):\n\n` +
      rs
        .filter(r => r.deltaStars === maxDeltas.stars)
        .map(r => `- [${r.name}](${r.url}) (${r.stars})`)
        .join('\n') +
      '\n\n';
  }
  if (maxDeltas.commits) {
    message +=
      `Most commits (+${maxDeltas.commits}):\n\n` +
      rs
        .filter(r => r.deltaCommits === maxDeltas.commits)
        .map(r => `- [${r.name}](${r.url}) (${r.commits})`)
        .join('\n') +
      '\n\n';
  }
  if (message) {
    const transporter = nodemailer.createTransport(process.env.SMTP_URL);
    transporter.use('compile', markdown());
    transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to: process.env.EMAIL_TO,
      subject: `Trending repositories for ${process.env.ORGANISATION}`,
      markdown: message
    });
  }
};
