<!-- Improved compatibility of back to top link: See: https://github.com/othneildrew/Best-README-Template/pull/73 -->
<a name="readme-top"></a>
<!--
*** Thanks for checking out the Best-README-Template. If you have a suggestion
*** that would make this better, please fork the repo and create a pull request
*** or simply open an issue with the tag "enhancement".
*** Don't forget to give the project a star!
*** Thanks again! Now go create something AMAZING! :D
-->



<!-- PROJECT SHIELDS -->
<!--
*** I'm using markdown "reference style" links for readability.
*** Reference links are enclosed in brackets [ ] instead of parentheses ( ).
*** See the bottom of this document for the declaration of the reference variables
*** for contributors-url, forks-url, etc. This is an optional, concise syntax you may use.
*** https://www.markdownguide.org/basic-syntax/#reference-style-links
-->
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![MIT License][license-shield]][license-url]

<br />

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
    </li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#contact">Contact</a></li>
  </ol>
</details>



<!-- ABOUT THE PROJECT -->
## About The Project

Easily set up collaborative editing with Supabase Realtime! Built with [YJS](https://docs.yjs.dev/).

Not recommended for production use in its current state. 

Contributors welcome!

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- USAGE EXAMPLES -->
## Usage

```json
"@kamick/supabaseprovider": "^0.0.2",
```

Input: 
```typescript
export interface SupabaseProviderConfiguration {
    /**
    * The identifier/name of your document
    */
    name: string;
    /**
     * The actual Y.js document
     */
    document: Y.Doc;
    /**
     * The awareness instance
     */
    awareness?: Awareness;
    /**
     * Details about the database to connect to
     */
    databaseDetails: {
        schema: string,
        table: string,
        updateColumns: { name: string, content: string },
        conflictColumns: string
    }
}
```

Example usage with React:
```javascript
const supabase = createClientComponentClient<Database>();
const router = useRouter();
const doc = useMemo(() => new Y.Doc(), []);
const provider = 
    useMemo(() => new SupabaseProvider(supabase, {
            name: documentName,
            document: doc,
            databaseDetails: {
            schema: {schema},
            table: {table},
            updateColumns: { name: {column_name}, content: {column_content} },
            conflictColumns: {conflict_columns_comma_concat},
            },
        }), [doc, documentName, supabase]);

return <TipTapEditor doc={doc} provider={provider} user={user} router={router} />;

```

<p align="right">(<a href="#readme-top">back to top</a>)</p>



<!-- ROADMAP -->
## Roadmap

- [ ] Add Changelog
- [ ] Add Additional Templates w/ Examples
- [ ] Add Testing
- [ ] Production ready

See the [open issues](https://github.com/kevinamick/supabaseprovider/issues) for a full list of proposed features (and known issues).

<p align="right">(<a href="#readme-top">back to top</a>)</p>



<!-- CONTRIBUTING -->
## Contributing

Contributions are what make the open source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

If you have a suggestion that would make this better, please fork the repo and create a pull request. You can also simply open an issue with the tag "enhancement".
Don't forget to give the project a star! Thanks again!

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

<p align="right">(<a href="#readme-top">back to top</a>)</p>



<!-- LICENSE -->
## License

Distributed under the MIT License. See `LICENSE.txt` for more information.

<p align="right">(<a href="#readme-top">back to top</a>)</p>



<!-- CONTACT -->
## Contact

Kevin Amick - [@kevinamick](https://twitter.com/kevinamick) - kevinamick81@gmail.com

Project Link: [https://github.com/kevinamick/supabaseprovider](https://github.com/your_username/repo_name)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- MARKDOWN LINKS & IMAGES -->
<!-- https://www.markdownguide.org/basic-syntax/#reference-style-links -->
[forks-shield]: https://img.shields.io/github/forks/kevinamick/supabaseprovider
[forks-url]: https://github.com/kevinamick/supabaseprovider/network/members
[stars-shield]: https://img.shields.io/github/stars/kevinamick/supabaseprovider
[stars-url]: https://github.com/kevinamick/supabaseprovider/stargazers
[issues-shield]: https://img.shields.io/github/issues/kevinamick/supabaseprovider
[issues-url]: https://github.com/kevinamick/supabaseprovider/issues
[license-shield]: https://img.shields.io/github/license/kevinamick/supabaseprovider
[license-url]: https://github.com/kevinamick/supabaseprovider/blob/main/LICENSE.txt
[linkedin-shield]: https://img.shields.io/badge/-LinkedIn-black.svg?style=for-the-badge&logo=linkedin&colorB=555
[linkedin-url]: https://linkedin.com/in/kevinamick