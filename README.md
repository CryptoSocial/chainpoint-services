# Chainpoint Services

[![JavaScript Style Guide](https://cdn.rawgit.com/feross/standard/master/badge.svg)](https://github.com/feross/standard)

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

Chainpoint Services is at the Core of the Tierion Network and
built as a modern [microservices architecture](https://martinfowler.com/articles/microservices.html).

The services provided are generally composed of Node.js applications
running within Alpine Linux Docker containers. These containers,
while intended to be run within a full Docker orchestration
system such as Kubernetes in production, run well on a single host
using [Docker Compose](https://docs.docker.com/compose/overview/).
This run method is suitable for development only.

## Important Notice

This software is intended to be run as the Core of the Tierion Network. It is not for end users. If you are interested in running a Tierion Node, or installing a copy of our command line interface please instead visit:

[https://github.com/chainpoint/chainpoint-node](https://github.com/chainpoint/chainpoint-node)

[https://github.com/chainpoint/chainpoint-cli](https://github.com/chainpoint/chainpoint-cli)


## TL;DR

Build and start the whole system locally with `make up`. Running `make help`
will display additional `Makefile` commands that are available.

```
git clone https://github.com/chainpoint/chainpoint-services
cd chainpoint-services
make
```

## Getting Started

This repository contains all of the code needed to
run the full application stack locally.

To do so you'll only need a functional Docker environment with the `docker`
and `docker-compose` commands available. In addition you'll need the `make`
utility.

On `macOS` the easiest way to install Docker is from the official
installation package which can be found [here](https://www.docker.com/docker-mac).

On Linux systems you may need to [install](https://docs.docker.com/compose/install/) `docker-compose`
separately in addition to Docker.

### Setup Environment Variables

You will need to set up environment variables before building.

Running `make build-config` will copy `.env.sample` to `.env`. This file will be used by `docker-compose` to set required environment variables.

You can modify the `.env` as needed, any changes will be ignored by Git.

## Startup

Running `make up` should build and start all services for you.

## License

[GNU Affero General Public License v3.0](http://www.gnu.org/licenses/agpl-3.0.txt)

```
Copyright (C) 2017 Tierion

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
```
